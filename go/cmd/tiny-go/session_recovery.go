package main

import (
	"encoding/json"
	"sort"
)

type currentTool struct {
	Name             string `json:"name"`
	DefinitionDigest string `json:"definitionDigest"`
	Replay           string `json:"replay"`
	ReplayKey        string `json:"replayKey"`
}
type currentConfiguration struct {
	ConfigurationDigest string        `json:"configurationDigest"`
	EnvironmentIdentity string        `json:"environmentIdentity"`
	Tools               []currentTool `json:"tools"`
}
type recoveryPlan map[string]any

func currentToolByName(current currentConfiguration, name string) *currentTool {
	for index := range current.Tools {
		if current.Tools[index].Name == name {
			return &current.Tools[index]
		}
	}
	return nil
}

func recoveryAssistant(state sessionState) (string, []any, bool) {
	if state.Operation.Kind != "run" || state.Operation.Step == nil || state.Operation.Step.SettledEntryID == "" {
		return "", nil, false
	}
	for index := len(state.Transcript) - 1; index >= 0; index-- {
		message := state.Transcript[index]
		calls, ok := message["tool_calls"].([]any)
		if message["role"] == "assistant" && ok && len(calls) > 0 {
			return state.Operation.Step.SettledEntryID, calls, true
		}
	}
	return "", nil, false
}

func recoveryCall(call any) (string, string, string) {
	value, _ := call.(map[string]any)
	function, _ := value["function"].(map[string]any)
	id, _ := value["id"].(string)
	name, _ := function["name"].(string)
	arguments, _ := function["arguments"].(string)
	return id, name, arguments
}

func syntheticResult(assistantID string, index int, callID, name, reason string) map[string]any {
	return map[string]any{
		"assistantEntryId": assistantID,
		"toolIndex":        index,
		"toolCallId":       callID,
		"toolName":         name,
		"reason":           reason,
		"content":          syntheticContent[reason],
	}
}

func interruptedResult(tool sessionToolState) map[string]any {
	result := syntheticResult(tool.AssistantEntryID, tool.ToolIndex, tool.ToolCallID, tool.ToolName, "interrupted")
	result["toolStartedId"] = tool.ToolStartedID
	result["resultEntryId"] = tool.ResultEntryID
	return result
}

func planRecovery(state sessionState, current currentConfiguration) recoveryPlan {
	operation := state.Operation
	if operation.Kind == "idle" {
		return recoveryPlan{"type": "finish", "outcome": "completed", "completion": "normal"}
	}

	assistantID, calls, hasAssistant := recoveryAssistant(state)
	pending := []sessionToolState{}
	if operation.Kind == "run" {
		for _, tool := range operation.ToolCalls {
			if tool.Status == "pending" {
				pending = append(pending, tool)
			}
		}
	}
	if operation.AbortRequested {
		if operation.Step != nil && operation.Step.Status == "attempting" {
			return recoveryPlan{"type": "closeAttempt", "error": map[string]any{"code": "aborted", "message": "Operation aborted"}}
		}
		if operation.Kind == "run" && hasAssistant {
			started := map[int]sessionToolState{}
			for _, tool := range operation.ToolCalls {
				if tool.AssistantEntryID == assistantID {
					started[tool.ToolIndex] = tool
				}
			}
			results := []any{}
			for index, raw := range calls {
				callID, name, _ := recoveryCall(raw)
				tool, exists := started[index]
				if exists && tool.Status == "pending" {
					results = append(results, interruptedResult(tool))
				} else if !exists {
					results = append(results, syntheticResult(assistantID, index, callID, name, "aborted"))
				}
			}
			if len(results) > 0 {
				return recoveryPlan{"type": "appendSynthetic", "results": results}
			}
		}
		return recoveryPlan{"type": "finish", "outcome": "aborted"}
	}

	if operation.Step == nil {
		contextID, kind := operation.InputThroughEntryID, operation.Kind
		if operation.Kind == "run" {
			contextID, kind = operation.InputEntryID, "assistant"
		}
		return recoveryPlan{"type": "startStep", "stepKind": kind, "attempt": 1, "contextThroughEntryId": contextID}
	}
	step := operation.Step
	if step.Status == "failed" {
		return recoveryPlan{"type": "finish", "outcome": "failed", "error": map[string]any{"code": "model_error", "message": "provider request failed"}}
	}
	if step.Status == "attempting" {
		if step.Attempt == 2 {
			return recoveryPlan{"type": "blocked", "reason": "attempts_exhausted"}
		}
		if step.ConfigurationDigest != current.ConfigurationDigest {
			return recoveryPlan{"type": "blocked", "reason": "configuration_changed"}
		}
		return recoveryPlan{"type": "startStep", "stepKind": step.StepKind, "attempt": 2, "stepId": step.StepID, "contextThroughEntryId": step.ContextThroughEntryID}
	}
	if operation.Kind == "compaction" {
		return recoveryPlan{"type": "finish", "outcome": "completed", "finalEntryId": operation.ResultEntryID}
	}
	if step.StopReason == "length" && hasAssistant {
		results := make([]any, len(calls))
		for index, raw := range calls {
			callID, name, _ := recoveryCall(raw)
			results[index] = syntheticResult(assistantID, index, callID, name, "truncated")
		}
		return recoveryPlan{"type": "appendSynthetic", "results": results}
	}
	if !hasAssistant {
		return recoveryPlan{"type": "finish", "outcome": "completed", "completion": "normal", "finalEntryId": step.SettledEntryID}
	}

	processed := map[int]bool{}
	for _, tool := range operation.ToolCalls {
		if tool.AssistantEntryID == assistantID {
			processed[tool.ToolIndex] = true
		}
	}
	for index, raw := range calls {
		if processed[index] {
			continue
		}
		callID, name, rawArguments := recoveryCall(raw)
		declaration := currentToolByName(current, name)
		if declaration == nil {
			return recoveryPlan{"type": "appendSynthetic", "results": []any{syntheticResult(assistantID, index, callID, name, "unknownTool")}}
		}
		arguments := map[string]any{}
		if err := json.Unmarshal([]byte(rawArguments), &arguments); err != nil || arguments == nil {
			return recoveryPlan{"type": "appendSynthetic", "results": []any{syntheticResult(assistantID, index, callID, name, "invalidArguments")}}
		}
		return recoveryPlan{"type": "startTool", "mode": "start", "assistantEntryId": assistantID, "toolIndex": index, "toolName": name, "arguments": arguments}
	}

	if len(pending) == 0 {
		last := operation.ToolCalls[len(operation.ToolCalls)-1]
		return recoveryPlan{"type": "startStep", "stepKind": "assistant", "attempt": 1, "contextThroughEntryId": last.ResultEntryID}
	}
	sort.Slice(pending, func(i, j int) bool { return pending[i].ToolIndex < pending[j].ToolIndex })
	tool := pending[0]
	if tool.EnvironmentIdentity != current.EnvironmentIdentity {
		return recoveryPlan{"type": "blocked", "reason": "environment_changed"}
	}
	declaration := currentToolByName(current, tool.ToolName)
	if declaration == nil || declaration.DefinitionDigest == "" {
		return recoveryPlan{"type": "blocked", "reason": "configuration_changed"}
	}
	if tool.Replay == "safe" && declaration.Replay == "safe" && declaration.ReplayKey == tool.ReplayKey {
		return recoveryPlan{"type": "startTool", "mode": "replay", "assistantEntryId": tool.AssistantEntryID, "toolIndex": tool.ToolIndex, "toolStartedId": tool.ToolStartedID, "toolName": tool.ToolName, "arguments": tool.Arguments}
	}
	if tool.Replay == "safe" && (declaration.Replay != "safe" || declaration.ReplayKey != tool.ReplayKey) {
		return recoveryPlan{"type": "blocked", "reason": "replay_declaration_changed"}
	}
	return recoveryPlan{"type": "appendSynthetic", "results": []any{interruptedResult(tool)}}
}
