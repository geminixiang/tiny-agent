package main

// Session fact builders: the single place where the agent loop shapes durable
// entries and records. The reducer validates these shapes; the builders keep
// the JSON key names out of the agent loop. See docs/session-design.md.

type operationFinishedExtra struct {
	Completion   string
	FinalEntryID string
	Error        map[string]any
}

func entryFact(id string, entry map[string]any) map[string]any {
	return map[string]any{"kind": "entry", "id": id, "entry": entry}
}

func recordFact(record map[string]any) map[string]any {
	return map[string]any{"kind": "record", "record": record}
}

func factError(code, message string) map[string]any {
	return map[string]any{"code": code, "message": message}
}

func usageMap(usage Usage) map[string]any {
	return map[string]any{"input": usage.Input, "output": usage.Output, "cacheRead": usage.CacheRead, "cacheWrite": usage.CacheWrite}
}

func usageFact(operationID, attemptID string, usage Usage) map[string]any {
	return map[string]any{"kind": "usage", "operationId": operationID, "attemptId": attemptID, "usage": usageMap(usage)}
}

func userMessageFact(id, content string) map[string]any {
	return entryFact(id, map[string]any{"type": "message", "message": map[string]any{"role": "user", "content": content}})
}

func runStartedFact(operationID, inputEntryID string) map[string]any {
	return recordFact(map[string]any{"type": "runStarted", "operationId": operationID, "operationKind": "run", "inputEntryId": inputEntryID})
}

func compactionStartedFact(operationID, inputThroughEntryID, resultEntryID string, compactedEntryIDs, retainedEntryIDs []any, sourceDigest string) map[string]any {
	return recordFact(map[string]any{
		"type":                "compactionStarted",
		"operationId":         operationID,
		"operationKind":       "compaction",
		"inputThroughEntryId": inputThroughEntryID,
		"resultEntryId":       resultEntryID,
		"compactedEntryIds":   compactedEntryIDs,
		"retainedEntryIds":    retainedEntryIDs,
		"sourceDigest":        sourceDigest,
	})
}

func stepAttemptFact(run durableRun, stepKind string, configuration sessionConfiguration) map[string]any {
	return recordFact(map[string]any{
		"type":                  "stepAttempt",
		"operationId":           run.OperationID,
		"stepId":                run.StepID,
		"attemptId":             run.AttemptID,
		"stepKind":              stepKind,
		"attempt":               run.Attempt,
		"contextThroughEntryId": run.ContextEntryID,
		"configurationSnapshot": configurationMap(configuration),
		"configurationDigest":   sessionConfigurationDigest(configuration),
	})
}

func stepFailedFact(operationID, stepID, attemptID string, err map[string]any) map[string]any {
	return recordFact(map[string]any{"type": "stepFailed", "operationId": operationID, "stepId": stepID, "attemptId": attemptID, "error": err})
}

func abortRequestedFact(operationID, operationKind, phase, toolCallID string) map[string]any {
	record := map[string]any{"type": "abortRequested", "operationId": operationID, "operationKind": operationKind, "phase": phase, "reason": "escape"}
	if toolCallID != "" {
		record["toolCallId"] = toolCallID
	}
	return recordFact(record)
}

func operationFinishedFact(operationID, operationKind, outcome string, extra operationFinishedExtra) map[string]any {
	record := map[string]any{"type": "operationFinished", "operationId": operationID, "operationKind": operationKind, "outcome": outcome}
	if extra.Completion != "" {
		record["completion"] = extra.Completion
	}
	if extra.FinalEntryID != "" {
		record["finalEntryId"] = extra.FinalEntryID
	}
	if extra.Error != nil {
		record["error"] = extra.Error
	}
	return recordFact(record)
}

func assistantMessageFact(id, stepID, attemptID, stopReason string, message Message) map[string]any {
	return entryFact(id, map[string]any{"type": "message", "stepId": stepID, "attemptId": attemptID, "stopReason": stopReason, "message": messageMap(message)})
}

func toolStartedFact(id string, run durableRun, toolIndex int, call ToolCall, args map[string]any, tool *Tool, environmentIdentity, resultEntryID string) map[string]any {
	fact := recordFact(map[string]any{
		"type":                "toolStarted",
		"operationId":         run.OperationID,
		"stepId":              run.StepID,
		"assistantEntryId":    run.AssistantEntryID,
		"toolIndex":           toolIndex,
		"toolCallId":          call.ID,
		"toolName":            call.Function.Name,
		"arguments":           args,
		"replay":              tool.Replay,
		"replayKey":           tool.ReplayKey,
		"environmentIdentity": environmentIdentity,
		"resultEntryId":       resultEntryID,
	})
	fact["id"] = id
	return fact
}

func toolResultFact(id, stepID, toolStartedID, toolName string, message Message, outcome string) map[string]any {
	result := map[string]any{"type": outcome}
	if outcome == "interrupted" {
		result = map[string]any{"type": "synthetic", "reason": "interrupted"}
	}
	return entryFact(id, map[string]any{"type": "message", "stepId": stepID, "message": messageMap(message), "toolName": toolName, "toolStartedId": toolStartedID, "result": result})
}

// syntheticToolResultFact writes a recovery-planner result. Results for a
// started tool reuse its reserved resultEntryId; unstarted ones use id.
func syntheticToolResultFact(id, stepID string, result map[string]any) map[string]any {
	message := toolResultMessage(result["toolCallId"].(string), result["content"].(string))
	entry := map[string]any{"type": "message", "stepId": stepID, "message": messageMap(message), "toolName": result["toolName"], "result": map[string]any{"type": "synthetic", "reason": result["reason"]}}
	if started, ok := result["toolStartedId"]; ok {
		id, entry["toolStartedId"] = result["resultEntryId"].(string), started
	} else {
		entry["assistantEntryId"], entry["toolIndex"] = result["assistantEntryId"], result["toolIndex"]
	}
	return entryFact(id, entry)
}

func compactionEntryFact(id, operationID, summary, compactedThroughEntryID string, retainedTail []any) map[string]any {
	return entryFact(id, map[string]any{"type": "compaction", "operationId": operationID, "summary": summary, "compactedThroughEntryId": compactedThroughEntryID, "retainedTail": retainedTail})
}
