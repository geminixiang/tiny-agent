package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

const zeroDigest = "sha256:0000000000000000000000000000000000000000000000000000000000000000"

type durableRun struct {
	OperationID, StepID, AttemptID, ContextEntryID, AssistantEntryID string
	Attempt                                                          int
}

type activeOperation struct {
	OperationID, Kind, Phase, ToolCallID string
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
	implementationIdentities := make([]any, 0, len(a.Tools))
	for _, tool := range a.Tools {
		definition := digestValue(map[string]any{"name": tool.Name, "description": tool.Description, "parameters": tool.Parameters, "identity": tool.Identity})
		implementationIdentity := map[string]any{"name": tool.Name, "replayKey": tool.ReplayKey}
		if tool.Identity != "" {
			implementationIdentity["identity"] = tool.Identity
		}
		declarations = append(declarations, sessionToolDeclaration{Name: tool.Name, DefinitionDigest: definition})
		currentTools = append(currentTools, currentTool{Name: tool.Name, DefinitionDigest: definition, Replay: tool.Replay, ReplayKey: tool.ReplayKey})
		implementationIdentities = append(implementationIdentities, implementationIdentity)
	}
	adapterIdentity := "openrouter:chat-completions:v1;tool-implementations=" + digestValue(implementationIdentities)
	configuration := sessionConfiguration{Model: model(), SystemPromptDigest: digestValue(value(a.Messages[0].Content)), Tools: declarations, AdapterIdentity: adapterIdentity, RoutingIdentity: "openrouter:" + model(), OutputOptionsDigest: zeroDigest}
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

func (a *Agent) projectSession() error {
	state := a.Session.State()
	a.Messages = a.Messages[:1]
	for _, raw := range state.ActiveContext {
		message, err := messageFromMap(raw)
		if err != nil {
			return err
		}
		a.Messages = append(a.Messages, message)
	}
	a.Usage = Usage{Input: int(state.Usage.Input), Output: int(state.Usage.Output), CacheRead: int(state.Usage.CacheRead), CacheWrite: int(state.Usage.CacheWrite)}
	if usage, ok := a.Session.LatestAssistantUsage(); ok {
		a.setLatestCacheHitRate(usage)
	}
	return nil
}

func (a *Agent) restoreSession() error {
	if a.Session == nil {
		return nil
	}
	if err := a.projectSession(); err != nil {
		return err
	}
	if a.Session.State().Operation.Kind == "idle" {
		return nil
	}
	return a.recoverSession()
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

func (a *Agent) startAttempt(run *durableRun, kind string, attempt int) error {
	if a.Session == nil {
		return nil
	}
	configuration, _, err := a.currentConfiguration()
	if err != nil {
		return err
	}
	if attempt == 1 {
		run.StepID = a.Session.NewID(time.Now())
	}
	run.AttemptID, run.Attempt = a.Session.NewID(time.Now().Add(time.Nanosecond)), attempt
	return a.Session.Commit([]map[string]any{{"kind": "record", "record": map[string]any{
		"type": "stepAttempt", "operationId": run.OperationID, "stepId": run.StepID, "attemptId": run.AttemptID,
		"stepKind": kind, "attempt": attempt, "contextThroughEntryId": run.ContextEntryID,
		"configurationSnapshot": configurationMap(configuration), "configurationDigest": sessionConfigurationDigest(configuration),
	}}})
}

func (a *Agent) failOperationAttempt(run durableRun, operationKind, code string, err error, finish bool) error {
	if a.Session == nil {
		return err
	}
	facts := []map[string]any{{"kind": "record", "record": map[string]any{"type": "stepFailed", "operationId": run.OperationID, "stepId": run.StepID, "attemptId": run.AttemptID, "error": map[string]any{"code": code, "message": err.Error()}}}}
	if finish {
		facts = append(facts, map[string]any{"kind": "record", "record": map[string]any{"type": "operationFinished", "operationId": run.OperationID, "operationKind": operationKind, "outcome": "failed", "error": map[string]any{"code": code, "message": err.Error()}}})
	}
	return errors.Join(err, a.Session.Commit(facts))
}

func (a *Agent) failAttempt(run durableRun, code string, err error, finish bool) error {
	return a.failOperationAttempt(run, "run", code, err, finish)
}

func (a *Agent) failModelResponse(run durableRun, response ModelResponse, err error) error {
	if a.Session == nil {
		return err
	}
	facts := []map[string]any{
		{"kind": "usage", "operationId": run.OperationID, "attemptId": run.AttemptID, "usage": map[string]any{"input": response.Usage.Input, "output": response.Usage.Output, "cacheRead": response.Usage.CacheRead, "cacheWrite": response.Usage.CacheWrite}},
		{"kind": "record", "record": map[string]any{"type": "stepFailed", "operationId": run.OperationID, "stepId": run.StepID, "attemptId": run.AttemptID, "error": map[string]any{"code": "model_error", "message": err.Error()}}},
		{"kind": "record", "record": map[string]any{"type": "operationFinished", "operationId": run.OperationID, "operationKind": "run", "outcome": "failed", "error": map[string]any{"code": "model_error", "message": err.Error()}}},
	}
	return errors.Join(err, a.Session.Commit(facts))
}

func (a *Agent) settleFailedAssistant(run *durableRun, response ModelResponse, err error) error {
	a.setLatestCacheHitRate(response.Usage)
	if a.Session == nil {
		return err
	}
	entryID := a.Session.NewID(time.Now())
	facts := []map[string]any{
		{"kind": "entry", "id": entryID, "entry": map[string]any{"type": "message", "stepId": run.StepID, "attemptId": run.AttemptID, "stopReason": response.StopReason, "message": messageMap(response.Message)}},
		{"kind": "usage", "operationId": run.OperationID, "attemptId": run.AttemptID, "usage": map[string]any{"input": response.Usage.Input, "output": response.Usage.Output, "cacheRead": response.Usage.CacheRead, "cacheWrite": response.Usage.CacheWrite}},
		{"kind": "record", "record": map[string]any{"type": "operationFinished", "operationId": run.OperationID, "operationKind": "run", "outcome": "failed", "error": map[string]any{"code": "model_error", "message": err.Error()}}},
	}
	return errors.Join(err, a.Session.Commit(facts))
}

func (a *Agent) settleAssistant(run *durableRun, response ModelResponse, finish bool) (string, error) {
	a.setLatestCacheHitRate(response.Usage)
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
	run.ContextEntryID, run.AssistantEntryID = entryID, entryID
	return entryID, nil
}

func findTool(tools []Tool, name string) *Tool {
	for index := range tools {
		if tools[index].Name == name {
			return &tools[index]
		}
	}
	return nil
}

func decodeToolArguments(raw string) (map[string]any, error) {
	args := map[string]any{}
	if err := json.Unmarshal([]byte(raw), &args); err != nil {
		return nil, err
	}
	if args == nil {
		return nil, errors.New("tool arguments must be an object")
	}
	return args, nil
}

func toolResultMessage(callID, content string) Message {
	return Message{Role: "tool", Content: text(content), ToolCallID: callID}
}

func (a *Agent) appendSynthetic(run *durableRun, index int, call ToolCall, reason string) error {
	content := syntheticContent[reason]
	message := toolResultMessage(call.ID, content)
	if a.Session != nil {
		id := a.Session.NewID(time.Now())
		if err := a.Session.Commit([]map[string]any{{"kind": "entry", "id": id, "entry": map[string]any{
			"type": "message", "stepId": run.StepID, "assistantEntryId": run.AssistantEntryID, "toolIndex": index,
			"message": messageMap(message), "toolName": call.Function.Name, "result": map[string]any{"type": "synthetic", "reason": reason},
		}}}); err != nil {
			return err
		}
		run.ContextEntryID = id
	}
	a.Messages = append(a.Messages, message)
	return nil
}

func (a *Agent) validateUnstartedTool() error {
	if a.Session == nil {
		return nil
	}
	state := a.Session.State()
	_, current, err := a.currentConfiguration()
	if err != nil {
		return err
	}
	if state.Operation.Step == nil || state.Operation.Step.ConfigurationDigest != current.ConfigurationDigest {
		return errors.New("Session recovery blocked: configuration_changed")
	}
	if state.Header.EnvironmentIdentity != current.EnvironmentIdentity {
		return errors.New("Session recovery blocked: environment_changed")
	}
	return nil
}

func (a *Agent) executeDurableTool(run *durableRun, index int, call ToolCall, selected *Tool, args map[string]any, replay *sessionToolState) error {
	if replay == nil {
		if err := a.validateUnstartedTool(); err != nil {
			return err
		}
	}
	startedID, resultID := "", ""
	if a.Session != nil {
		identity, err := environmentIdentity()
		if err != nil {
			return err
		}
		if replay == nil {
			startedID, resultID = a.Session.NewID(time.Now()), a.Session.NewID(time.Now().Add(time.Nanosecond))
			fact := map[string]any{"kind": "record", "id": startedID, "record": map[string]any{
				"type": "toolStarted", "operationId": run.OperationID, "stepId": run.StepID, "assistantEntryId": run.AssistantEntryID,
				"toolIndex": index, "toolCallId": call.ID, "toolName": call.Function.Name, "arguments": args,
				"replay": selected.Replay, "replayKey": selected.ReplayKey, "environmentIdentity": identity, "resultEntryId": resultID,
			}}
			if err := a.Session.Commit([]map[string]any{fact}); err != nil {
				return err
			}
		} else {
			startedID, resultID = replay.ToolStartedID, replay.ResultEntryID
		}
	}
	a.OnTool(ToolEvent{Phase: "start", Name: call.Function.Name, Args: stringifyArgs(args)})
	ctx := a.beginOperation(run.OperationID, "run", "tool", call.ID)
	result, toolErr := selected.Execute(ctx, args)
	aborted := a.endOperation(ctx)
	if aborted {
		return a.reconcileAbort()
	}
	resultType := "success"
	if toolErr != nil {
		result, resultType = "Error: "+toolErr.Error(), "error"
	}
	a.OnTool(ToolEvent{Phase: "end", Name: call.Function.Name, Result: result})
	message := toolResultMessage(call.ID, result)
	if a.Session != nil {
		if err := a.Session.Commit([]map[string]any{{"kind": "entry", "id": resultID, "entry": map[string]any{
			"type": "message", "stepId": run.StepID, "message": messageMap(message), "toolName": call.Function.Name,
			"toolStartedId": startedID, "result": map[string]any{"type": resultType},
		}}}); err != nil {
			return err
		}
		run.ContextEntryID = resultID
	}
	a.Messages = append(a.Messages, message)
	return nil
}

func stringifyArgs(args map[string]any) map[string]string {
	out := map[string]string{}
	for key, value := range args {
		if text, ok := value.(string); ok {
			out[key] = text
		}
	}
	return out
}

func (a *Agent) beginOperation(operationID, kind, phase, toolCallID string) context.Context {
	a.mu.Lock()
	defer a.mu.Unlock()
	ctx, cancel := context.WithCancel(context.Background())
	a.cancel, a.active = cancel, &activeOperation{operationID, kind, phase, toolCallID}
	return ctx
}

func (a *Agent) requestAbort() error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.cancel == nil || a.active == nil {
		return nil
	}
	active := *a.active
	if active.OperationID == "" {
		a.cancel()
		return nil
	}
	if a.Session != nil {
		record := map[string]any{"type": "abortRequested", "operationId": active.OperationID, "operationKind": active.Kind, "phase": active.Phase, "reason": "escape"}
		if active.Phase == "tool" {
			record["toolCallId"] = active.ToolCallID
		}
		if err := a.Session.Commit([]map[string]any{{"kind": "record", "record": record}}); err != nil {
			return err
		}
	}
	a.cancel()
	return nil
}

func (a *Agent) abort() { _ = a.requestAbort() }

func (a *Agent) reconcileAbort() error {
	if a.Session == nil {
		return context.Canceled
	}
	_, current, err := a.currentConfiguration()
	if err != nil {
		return err
	}
	for a.Session.State().Operation.Kind != "idle" {
		plan := planRecovery(a.Session.State(), current)
		if err := a.applyRecoveryPlan(plan); err != nil {
			return err
		}
	}
	_ = a.projectSession()
	return context.Canceled
}

func (a *Agent) recoverSession() error {
	_, current, err := a.currentConfiguration()
	if err != nil {
		return err
	}
	if err := a.projectSession(); err != nil {
		return err
	}
	for a.Session.State().Operation.Kind != "idle" {
		plan := planRecovery(a.Session.State(), current)
		if plan["type"] == "blocked" {
			return fmt.Errorf("Session recovery blocked: %s", plan["reason"])
		}
		if err := a.applyRecoveryPlan(plan); err != nil {
			return err
		}
		if err := a.projectSession(); err != nil {
			return err
		}
		_, current, err = a.currentConfiguration()
		if err != nil {
			return err
		}
	}
	return a.projectSession()
}

func (a *Agent) applyRecoveryPlan(plan recoveryPlan) error {
	state := a.Session.State()
	operation := state.Operation
	number := func(value any) int {
		switch value := value.(type) {
		case int:
			return value
		case float64:
			return int(value)
		}
		return 0
	}
	switch plan["type"] {
	case "appendSynthetic":
		results := plan["results"].([]any)
		facts := make([]map[string]any, 0, len(results))
		for _, raw := range results {
			result := raw.(map[string]any)
			message := toolResultMessage(result["toolCallId"].(string), result["content"].(string))
			entry := map[string]any{"type": "message", "stepId": operation.Step.StepID, "message": messageMap(message), "toolName": result["toolName"], "result": map[string]any{"type": "synthetic", "reason": result["reason"]}}
			id := a.Session.NewID(time.Now())
			if started, ok := result["toolStartedId"]; ok {
				id, entry["toolStartedId"] = result["resultEntryId"].(string), started
			} else {
				entry["assistantEntryId"], entry["toolIndex"] = result["assistantEntryId"], result["toolIndex"]
			}
			facts = append(facts, map[string]any{"kind": "entry", "id": id, "entry": entry})
		}
		return a.Session.Commit(facts)
	case "closeAttempt":
		return a.Session.Commit([]map[string]any{{"kind": "record", "record": map[string]any{"type": "stepFailed", "operationId": operation.OperationID, "stepId": operation.Step.StepID, "attemptId": operation.Step.AttemptID, "error": plan["error"]}}})
	case "finish":
		record := map[string]any{"type": "operationFinished", "operationId": operation.OperationID, "operationKind": operation.Kind, "outcome": plan["outcome"]}
		if final, ok := plan["finalEntryId"]; ok {
			record["finalEntryId"] = final
		}
		if completion, ok := plan["completion"]; ok {
			record["completion"] = completion
		}
		if record["outcome"] == "failed" {
			record["error"] = plan["error"]
		}
		return a.Session.Commit([]map[string]any{{"kind": "record", "record": record}})
	case "startStep":
		if operation.Kind == "compaction" {
			return a.recoverCompaction(plan, number(plan["attempt"]))
		}
		return a.recoverStep(plan, number(plan["attempt"]))
	case "startTool":
		return a.recoverTool(plan)
	}
	return fmt.Errorf("unsupported recovery plan: %v", plan)
}

func (a *Agent) recoverStep(plan recoveryPlan, attempt int) error {
	state := a.Session.State()
	run := durableRun{OperationID: state.Operation.OperationID, ContextEntryID: plan["contextThroughEntryId"].(string), Attempt: attempt}
	if state.Operation.Step != nil {
		run.StepID = state.Operation.Step.StepID
	}
	if err := a.startAttempt(&run, plan["stepKind"].(string), run.Attempt); err != nil {
		return err
	}
	ctx := a.beginOperation(run.OperationID, state.Operation.Kind, "model", "")
	response, err := a.callModel(ctx, a.Messages, a.toolDefinitions())
	aborted := a.endOperation(ctx)
	if aborted {
		return a.reconcileAbort()
	}
	if err != nil {
		return a.failAttempt(run, "model_error", err, true)
	}
	stop := response.StopReason
	if stop == "tool_calls" || stop == "function_call" {
		stop = "toolUse"
	}
	if stop != "stop" && stop != "toolUse" && stop != "length" {
		return a.failAttempt(run, "model_error", fmt.Errorf("unsupported finish_reason: %s", response.StopReason), true)
	}
	response.StopReason = stop
	if stop == "stop" && len(response.Message.ToolCalls) != 0 {
		return a.failModelResponse(run, response, errors.New("Model returned tool calls with finish_reason: stop"))
	}
	finish := stop == "stop" && strings.TrimSpace(value(response.Message.Content)) != ""
	if stop == "stop" && !finish {
		return a.settleFailedAssistant(&run, response, errors.New("Model returned an empty response (finish_reason: stop)"))
	}
	if stop == "length" && len(response.Message.ToolCalls) == 0 {
		return a.settleFailedAssistant(&run, response, errors.New("Model response reached the token limit without tool calls"))
	}
	_, err = a.settleAssistant(&run, response, finish)
	return err
}

func (a *Agent) compactionSource(operation sessionOperation) ([]sessionMessageFact, []sessionMessageFact, error) {
	state := a.Session.State()
	byID := map[string]sessionMessageFact{}
	for _, item := range state.messageFacts {
		byID[item.ID] = item
	}
	collect := func(ids []string) ([]sessionMessageFact, error) {
		items := make([]sessionMessageFact, len(ids))
		for index, id := range ids {
			item, ok := byID[id]
			if !ok {
				return nil, errors.New("compaction source missing")
			}
			items[index] = item
		}
		return items, nil
	}
	compacted, err := collect(operation.compactedEntryIDs)
	if err != nil {
		return nil, nil, err
	}
	retained, err := collect(operation.retainedEntryIDs)
	return compacted, retained, err
}

func (a *Agent) executeCompaction(run durableRun) error {
	state := a.Session.State()
	_, retained, err := a.compactionSource(state.Operation)
	if err != nil {
		return err
	}
	retainedCount := len(retained)
	active := a.Messages[1:]
	if retainedCount > len(active) {
		return errors.New("compaction active context mismatch")
	}
	source := active[:len(active)-retainedCount]
	encoded, _ := json.Marshal(source)
	prompt := []Message{{Role: "system", Content: text("Summarize this coding session compactly. Preserve decisions, changed files, errors, and next steps.")}, {Role: "user", Content: text(string(encoded))}}
	ctx := a.beginOperation(run.OperationID, "compaction", "compact", "")
	response, requestErr := a.callModel(ctx, prompt, nil)
	aborted := a.endOperation(ctx)
	if aborted {
		return a.reconcileAbort()
	}
	if requestErr != nil {
		return a.failOperationAttempt(run, "compaction", "model_error", requestErr, true)
	}
	stop := response.StopReason
	if stop == "tool_calls" || stop == "function_call" {
		stop = "toolUse"
	}
	summary := value(response.Message.Content)
	if stop != "stop" || len(response.Message.ToolCalls) != 0 || strings.TrimSpace(summary) == "" {
		return a.failOperationAttempt(run, "compaction", "model_error", errors.New("Model returned an invalid compaction summary"), true)
	}
	retainedTail := make([]any, len(retained))
	for index, item := range retained {
		retainedTail[index] = map[string]any{"sourceEntryId": item.ID, "message": item.Message}
	}
	if err := a.Session.Commit([]map[string]any{
		{"kind": "usage", "operationId": run.OperationID, "attemptId": run.AttemptID, "usage": map[string]any{"input": response.Usage.Input, "output": response.Usage.Output, "cacheRead": response.Usage.CacheRead, "cacheWrite": response.Usage.CacheWrite}},
		{"kind": "entry", "id": state.Operation.ResultEntryID, "entry": map[string]any{"type": "compaction", "operationId": run.OperationID, "summary": summary, "compactedThroughEntryId": state.Operation.compactedEntryIDs[len(state.Operation.compactedEntryIDs)-1], "retainedTail": retainedTail}},
	}); err != nil {
		return err
	}
	return a.Session.Commit([]map[string]any{{"kind": "record", "record": map[string]any{"type": "operationFinished", "operationId": run.OperationID, "operationKind": "compaction", "outcome": "completed", "finalEntryId": state.Operation.ResultEntryID}}})
}

func (a *Agent) recoverCompaction(plan recoveryPlan, attempt int) error {
	state := a.Session.State()
	run := durableRun{OperationID: state.Operation.OperationID, ContextEntryID: plan["contextThroughEntryId"].(string), Attempt: attempt}
	if state.Operation.Step != nil {
		run.StepID = state.Operation.Step.StepID
	}
	if err := a.startAttempt(&run, "compaction", attempt); err != nil {
		return err
	}
	return a.executeCompaction(run)
}

func (a *Agent) recoverTool(plan recoveryPlan) error {
	state := a.Session.State()
	assistantID := plan["assistantEntryId"].(string)
	var assistant Message
	for entryIndex, raw := range state.Transcript {
		if entryIndex >= len(state.entryIDs) || state.entryIDs[entryIndex] != assistantID || raw["role"] != "assistant" {
			continue
		}
		assistant, _ = messageFromMap(raw)
		break
	}
	index := 0
	switch value := plan["toolIndex"].(type) {
	case int:
		index = value
	case float64:
		index = int(value)
	}
	if index >= len(assistant.ToolCalls) {
		return errors.New("recovery tool call missing")
	}
	call := assistant.ToolCalls[index]
	selected := findTool(a.Tools, call.Function.Name)
	if selected == nil {
		return errors.New("recovery tool unavailable")
	}
	run := durableRun{OperationID: state.Operation.OperationID, StepID: state.Operation.Step.StepID, AssistantEntryID: assistantID, ContextEntryID: state.Operation.Step.ContextThroughEntryID}
	var replay *sessionToolState
	if plan["mode"] == "replay" {
		for i := range state.Operation.ToolCalls {
			if state.Operation.ToolCalls[i].ToolStartedID == plan["toolStartedId"] {
				replay = &state.Operation.ToolCalls[i]
			}
		}
	}
	return a.executeDurableTool(&run, index, call, selected, plan["arguments"].(map[string]any), replay)
}
