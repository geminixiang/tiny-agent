package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

const zeroDigest = "sha256:0000000000000000000000000000000000000000000000000000000000000000"

type durableRun struct {
	OperationID, StepID, AttemptID, ContextEntryID string
}

func digestValue(value any) string {
	encoded, _ := json.Marshal(value)
	normalized, err := sessionDecode(encoded)
	if err != nil {
		panic(err)
	}
	canonical, err := sessionCanonical(normalized)
	if err != nil {
		panic(err)
	}
	sum := sha256.Sum256([]byte(canonical))
	return "sha256:" + hex.EncodeToString(sum[:])
}

func (a *Agent) currentConfiguration() (sessionConfiguration, currentConfiguration, error) {
	identity, err := environmentIdentity()
	if err != nil {
		return sessionConfiguration{}, currentConfiguration{}, err
	}
	declarations := make([]sessionToolDeclaration, 0, len(a.Tools))
	currentTools := make([]currentTool, 0, len(a.Tools))
	for _, tool := range a.Tools {
		definition := digestValue(map[string]any{"name": tool.Name, "description": tool.Description, "parameters": tool.Parameters})
		declarations = append(declarations, sessionToolDeclaration{Name: tool.Name, DefinitionDigest: definition})
		currentTools = append(currentTools, currentTool{Name: tool.Name, DefinitionDigest: definition, Replay: tool.Replay, ReplayKey: tool.ReplayKey})
	}
	configuration := sessionConfiguration{Model: model(), SystemPromptDigest: digestValue(value(a.Messages[0].Content)), Tools: declarations, AdapterIdentity: "openrouter:chat-completions:v1", RoutingIdentity: "openrouter:" + model(), OutputOptionsDigest: zeroDigest}
	digest := sessionConfigurationDigest(configuration)
	return configuration, currentConfiguration{ConfigurationDigest: digest, EnvironmentIdentity: identity, Tools: currentTools}, nil
}

func configurationMap(configuration sessionConfiguration) map[string]any {
	tools := make([]any, len(configuration.Tools))
	for index, tool := range configuration.Tools {
		tools[index] = map[string]any{"name": tool.Name, "definitionDigest": tool.DefinitionDigest}
	}
	return map[string]any{"model": configuration.Model, "systemPromptDigest": configuration.SystemPromptDigest, "tools": tools, "adapterIdentity": configuration.AdapterIdentity, "routingIdentity": configuration.RoutingIdentity, "outputOptionsDigest": configuration.OutputOptionsDigest}
}

func messageMap(message Message) map[string]any {
	encoded, _ := json.Marshal(message)
	result := map[string]any{}
	_ = json.Unmarshal(encoded, &result)
	return result
}

func messageFromMap(message sessionMessage) (Message, error) {
	encoded, err := json.Marshal(message)
	if err != nil {
		return Message{}, err
	}
	var result Message
	return result, json.Unmarshal(encoded, &result)
}

func (a *Agent) restoreSession() error {
	if a.Session == nil {
		return nil
	}
	state := a.Session.State()
	if state.Operation.Kind != "idle" {
		_, current, err := a.currentConfiguration()
		if err != nil {
			return err
		}
		return fmt.Errorf("Session recovery required: %v", planRecovery(state, current))
	}
	a.Messages = a.Messages[:1]
	for _, raw := range state.ActiveContext {
		message, err := messageFromMap(raw)
		if err != nil {
			return err
		}
		a.Messages = append(a.Messages, message)
	}
	a.Usage = Usage{Input: int(state.Usage.Input), Output: int(state.Usage.Output), CacheRead: int(state.Usage.CacheRead), CacheWrite: int(state.Usage.CacheWrite)}
	prompt := a.Usage.Input + a.Usage.CacheRead + a.Usage.CacheWrite
	if prompt > 0 {
		rate := float64(a.Usage.CacheRead) / float64(prompt) * 100
		a.Usage.CacheHitRate = &rate
	}
	return nil
}

func (a *Agent) startDurableRun(input string) (durableRun, error) {
	run := durableRun{}
	if a.Session == nil {
		return run, nil
	}
	now := time.Now()
	run.OperationID, run.ContextEntryID = a.Session.NewID(now), a.Session.NewID(now.Add(time.Nanosecond))
	return run, a.Session.Commit([]map[string]any{
		{"kind": "entry", "id": run.ContextEntryID, "entry": map[string]any{"type": "message", "message": map[string]any{"role": "user", "content": input}}},
		{"kind": "record", "record": map[string]any{"type": "runStarted", "operationId": run.OperationID, "operationKind": "run", "inputEntryId": run.ContextEntryID}},
	})
}

func (a *Agent) startAttempt(run *durableRun) error {
	if a.Session == nil {
		return nil
	}
	configuration, _, err := a.currentConfiguration()
	if err != nil {
		return err
	}
	run.StepID, run.AttemptID = a.Session.NewID(time.Now()), a.Session.NewID(time.Now().Add(time.Nanosecond))
	return a.Session.Commit([]map[string]any{
		{
			"kind": "record",
			"record": map[string]any{
				"type": "stepAttempt", "operationId": run.OperationID,
				"stepId": run.StepID, "attemptId": run.AttemptID,
				"stepKind": "assistant", "attempt": 1,
				"contextThroughEntryId": run.ContextEntryID,
				"configurationSnapshot": configurationMap(configuration),
				"configurationDigest":   sessionConfigurationDigest(configuration),
			},
		},
	})
}

func (a *Agent) failAttempt(run durableRun, err error) error {
	if a.Session == nil {
		return err
	}
	commitErr := a.Session.Commit([]map[string]any{
		{"kind": "record", "record": map[string]any{"type": "stepFailed", "operationId": run.OperationID, "stepId": run.StepID, "attemptId": run.AttemptID, "error": map[string]any{"code": "model_error", "message": err.Error()}}},
		{"kind": "record", "record": map[string]any{"type": "operationFinished", "operationId": run.OperationID, "operationKind": "run", "outcome": "failed", "completion": "error", "error": map[string]any{"code": "model_error", "message": err.Error()}}},
	})
	return errors.Join(err, commitErr)
}

func (a *Agent) settleAssistant(run *durableRun, response ModelResponse, finish bool) (string, error) {
	if a.Session == nil {
		return "", nil
	}
	entryID := a.Session.NewID(time.Now())
	facts := []map[string]any{
		{"kind": "entry", "id": entryID, "entry": map[string]any{"type": "message", "stepId": run.StepID, "attemptId": run.AttemptID, "stopReason": response.StopReason, "message": messageMap(response.Message)}},
		{"kind": "usage", "operationId": run.OperationID, "attemptId": run.AttemptID, "usage": map[string]any{"input": response.Usage.Input, "output": response.Usage.Output, "cacheRead": response.Usage.CacheRead, "cacheWrite": response.Usage.CacheWrite}},
	}
	if finish {
		facts = append(facts, map[string]any{"kind": "record", "record": map[string]any{"type": "operationFinished", "operationId": run.OperationID, "operationKind": "run", "outcome": "completed", "completion": "normal", "finalEntryId": entryID}})
	}
	if err := a.Session.Commit(facts); err != nil {
		return "", err
	}
	run.ContextEntryID = entryID
	return entryID, nil
}
