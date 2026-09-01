package main

import (
	"fmt"
	"math"
	"time"
)

type lifecycleSink interface {
	Emit(map[string]any)
	Close() error
}

type executionLifecycle interface {
	Observe(map[string]any)
	Committed([]map[string]any)
	Close() error
}

type noopLifecycle struct{}

func (noopLifecycle) Observe(map[string]any)     {}
func (noopLifecycle) Committed([]map[string]any) {}
func (noopLifecycle) Close() error               { return nil }

type callbackLifecycleSink func(map[string]any)

func (sink callbackLifecycleSink) Emit(event map[string]any) { sink(event) }
func (callbackLifecycleSink) Close() error                   { return nil }

type lifecycleOperation struct {
	Kind      string
	StartedAt time.Time
	Recovery  bool
}

type lifecycleModel struct {
	OperationID string
	Kind        string
	StepID      string
	AttemptID   string
	StartedAt   time.Time
	Recovery    bool
}

type lifecycleTool struct {
	OperationID     string
	StepID          string
	AttemptID       string
	ParentAttemptID string
	ToolStartedID   string
	ToolCallID      string
	Tool            string
	StartedAt       time.Time
	Recovery        bool
}

type lifecycleAnswer struct {
	OperationID string
	Content     string
}

type lifecycleProjector struct {
	sinks          []lifecycleSink
	sessionID      string
	operations     map[string]lifecycleOperation
	models         map[string]lifecycleModel
	tools          map[string]lifecycleTool
	usage          map[string]Usage
	operationUsage map[string]Usage
	answers        map[string]lifecycleAnswer
}

func newLifecycleProjector(sinks ...lifecycleSink) *lifecycleProjector {
	return &lifecycleProjector{
		sinks:          sinks,
		operations:     map[string]lifecycleOperation{},
		models:         map[string]lifecycleModel{},
		tools:          map[string]lifecycleTool{},
		usage:          map[string]Usage{},
		operationUsage: map[string]Usage{},
		answers:        map[string]lifecycleAnswer{},
	}
}

func (p *lifecycleProjector) Observe(event map[string]any) {
	eventType, _ := event["type"].(string)
	if eventType == "session.attached" {
		p.sessionID, _ = event["sessionId"].(string)
	}
	if eventType == "recovery.attached" {
		operationID, operationOK := event["operationId"].(string)
		kind, kindOK := event["operationKind"].(string)
		if p.sessionID == "" || !operationOK || !kindOK {
			return
		}
		startedAt := lifecycleTime(event["timestamp"])
		p.operations[operationID] = lifecycleOperation{Kind: kind, StartedAt: startedAt, Recovery: true}
		p.operationUsage[operationID] = Usage{}
		p.publish(map[string]any{"type": "operation.recovered", "timestamp": lifecycleTimestamp(event), "sessionId": p.sessionID, "operationId": operationID, "operationKind": kind, "recovery": true})
		return
	}
	if eventType == "tool.started" {
		if p.sessionID == "" {
			return
		}
		toolStartedID, ok := event["toolStartedId"].(string)
		if !ok {
			return
		}
		attempt := lifecycleTool{
			OperationID: stringValue(event["operationId"]), StepID: stringValue(event["stepId"]),
			AttemptID: stringValue(event["attemptId"]), ParentAttemptID: stringValue(event["parentAttemptId"]),
			ToolStartedID: toolStartedID, ToolCallID: stringValue(event["toolCallId"]), Tool: stringValue(event["tool"]),
			StartedAt: lifecycleTime(event["timestamp"]), Recovery: boolValue(event["recovery"]),
		}
		p.tools[toolStartedID] = attempt
		published := cloneEvent(event)
		published["sessionId"] = p.sessionID
		published["timestamp"] = lifecycleTimestamp(event)
		p.publish(published)
		return
	}
	p.publish(event)
}

func (p *lifecycleProjector) Committed(facts []map[string]any) {
	transactionUsage := map[string]Usage{}
	for _, fact := range facts {
		if fact["kind"] != "usage" {
			continue
		}
		attemptID, ok := fact["attemptId"].(string)
		usage, usageOK := lifecycleUsage(fact["usage"])
		if !ok || !usageOK {
			continue
		}
		transactionUsage[attemptID] = usage
		p.usage[attemptID] = usage
		if operationID, ok := fact["operationId"].(string); ok {
			p.addOperationUsage(operationID, usage)
		}
	}
	for _, fact := range facts {
		p.applyFact(fact, transactionUsage)
	}
}

func (p *lifecycleProjector) Close() error {
	timestamp := time.Now().UTC()
	for attemptID := range p.models {
		p.completeModel(attemptID, timestamp, "effect_unknown", p.usage[attemptID], "")
	}
	for toolStartedID, attempt := range p.tools {
		p.publish(p.toolCompleted(attempt, timestamp, "effect_unknown"))
		delete(p.tools, toolStartedID)
	}
	for _, sink := range p.sinks {
		_ = sink.Close()
	}
	return nil
}

func (p *lifecycleProjector) applyFact(fact map[string]any, transactionUsage map[string]Usage) {
	timestamp := lifecycleTime(fact["timestamp"])
	if fact["kind"] == "record" {
		record, ok := fact["record"].(map[string]any)
		if ok {
			p.applyRecord(fact, record, timestamp)
		}
		return
	}
	if fact["kind"] != "entry" {
		return
	}
	entry, ok := fact["entry"].(map[string]any)
	if !ok {
		return
	}
	if entry["type"] == "message" {
		message, _ := entry["message"].(map[string]any)
		if message["role"] == "assistant" {
			attemptID, attemptOK := entry["attemptId"].(string)
			if !attemptOK {
				return
			}
			if content, contentOK := message["content"].(string); contentOK {
				if id, idOK := fact["id"].(string); idOK {
					if attempt, found := p.models[attemptID]; found {
						p.answers[id] = lifecycleAnswer{OperationID: attempt.OperationID, Content: content}
					}
				}
			}
			p.completeModel(attemptID, timestamp, "succeeded", transactionUsage[attemptID], "")
			return
		}
		if message["role"] == "tool" {
			if toolStartedID, toolOK := entry["toolStartedId"].(string); toolOK {
				p.completeTool(toolStartedID, entry, timestamp)
			}
		}
		return
	}
	if entry["type"] != "compaction" {
		return
	}
	operationID, ok := entry["operationId"].(string)
	if !ok {
		return
	}
	for attemptID, attempt := range p.models {
		if attempt.OperationID == operationID && attempt.Kind == "compaction" {
			p.completeModel(attemptID, timestamp, "succeeded", p.usage[attemptID], "")
			return
		}
	}
}

func (p *lifecycleProjector) applyRecord(fact, record map[string]any, timestamp time.Time) {
	if p.sessionID == "" {
		return
	}
	recordType, _ := record["type"].(string)
	if recordType == "runStarted" || recordType == "compactionStarted" {
		operationID, ok := record["operationId"].(string)
		if !ok {
			return
		}
		kind := "run"
		if recordType == "compactionStarted" {
			kind = "compaction"
		}
		p.operations[operationID] = lifecycleOperation{Kind: kind, StartedAt: timestamp}
		p.operationUsage[operationID] = Usage{}
		p.publish(map[string]any{"type": "operation.started", "timestamp": timestamp.Format(time.RFC3339Nano), "sessionId": p.sessionID, "operationId": operationID, "operationKind": kind, "recovery": false})
		return
	}
	if recordType == "stepAttempt" {
		operationID, operationOK := record["operationId"].(string)
		stepID, stepOK := record["stepId"].(string)
		attemptID, attemptOK := record["attemptId"].(string)
		attemptNumber, numberOK := numberValue(record["attempt"])
		if !operationOK || !stepOK || !attemptOK || !numberOK {
			return
		}
		operation := p.operations[operationID]
		kind := "run"
		if record["stepKind"] == "compaction" {
			kind = "compaction"
		}
		attempt := lifecycleModel{OperationID: operationID, Kind: kind, StepID: stepID, AttemptID: attemptID, StartedAt: timestamp, Recovery: operation.Recovery}
		p.models[attemptID] = attempt
		p.publish(map[string]any{"type": "model.started", "timestamp": timestamp.Format(time.RFC3339Nano), "sessionId": p.sessionID, "operationId": operationID, "operationKind": kind, "stepId": stepID, "attemptId": attemptID, "attempt": attemptNumber, "recovery": attempt.Recovery})
		return
	}
	if recordType == "stepFailed" {
		operationID := stringValue(record["operationId"])
		stepID := stringValue(record["stepId"])
		attemptID := stringValue(record["attemptId"])
		errorValue, _ := record["error"].(map[string]any)
		code := stringValue(errorValue["code"])
		outcome := "failed"
		if code == "aborted" {
			outcome = "cancelled"
		}
		if _, found := p.models[attemptID]; !found && p.operations[operationID].Recovery {
			operation := p.operations[operationID]
			event := map[string]any{"type": "model.reconciled", "timestamp": timestamp.Format(time.RFC3339Nano), "sessionId": p.sessionID, "operationId": operationID, "operationKind": operation.Kind, "stepId": stepID, "attemptId": attemptID, "recovery": true, "outcome": outcome}
			if code != "" {
				event["errorType"] = code
			}
			p.publish(event)
			return
		}
		p.completeModel(attemptID, timestamp, outcome, p.usage[attemptID], code)
		return
	}
	if recordType == "toolStarted" {
		id, idOK := fact["id"].(string)
		operationID, operationOK := record["operationId"].(string)
		stepID, stepOK := record["stepId"].(string)
		toolCallID, callOK := record["toolCallId"].(string)
		tool, toolOK := record["toolName"].(string)
		replay, replayOK := record["replay"].(string)
		if !idOK || !operationOK || !stepOK || !callOK || !toolOK || !replayOK || (replay != "safe" && replay != "never") {
			return
		}
		p.publish(map[string]any{"type": "tool.admitted", "timestamp": timestamp.Format(time.RFC3339Nano), "sessionId": p.sessionID, "operationId": operationID, "stepId": stepID, "toolStartedId": id, "toolCallId": toolCallID, "tool": tool, "replay": replay, "recovery": p.operations[operationID].Recovery})
		return
	}
	if recordType == "abortRequested" {
		operationID := stringValue(record["operationId"])
		event := map[string]any{"type": "cancel.requested", "timestamp": timestamp.Format(time.RFC3339Nano), "sessionId": p.sessionID, "operationId": operationID, "operationKind": stringValue(record["operationKind"]), "phase": stringValue(record["phase"]), "recovery": p.operations[operationID].Recovery}
		if toolCallID, ok := record["toolCallId"].(string); ok {
			event["toolCallId"] = toolCallID
		}
		p.publish(event)
		return
	}
	if recordType != "operationFinished" {
		return
	}
	operationID, ok := record["operationId"].(string)
	operation, found := p.operations[operationID]
	if !ok || !found {
		return
	}
	outcome := "failed"
	if record["outcome"] == "completed" {
		outcome = "succeeded"
	} else if record["outcome"] == "aborted" {
		outcome = "cancelled"
	}
	event := map[string]any{"type": "operation.completed", "timestamp": timestamp.Format(time.RFC3339Nano), "sessionId": p.sessionID, "operationId": operationID, "operationKind": operation.Kind, "recovery": operation.Recovery, "durationMs": lifecycleDuration(operation.StartedAt, timestamp), "outcome": outcome}
	if completion, ok := record["completion"].(string); ok && (completion == "normal" || completion == "truncated") {
		event["completion"] = completion
	}
	if finalID, ok := record["finalEntryId"].(string); ok {
		if answer, found := p.answers[finalID]; found {
			event["answer"] = answer.Content
		}
	}
	if usage, found := p.operationUsage[operationID]; found {
		event["usage"] = lifecycleUsageMap(usage)
	}
	if errorValue, ok := record["error"].(map[string]any); ok {
		if code, ok := errorValue["code"].(string); ok {
			event["errorType"] = code
		}
		if message, ok := errorValue["message"].(string); ok {
			event["errorMessage"] = message
		}
	}
	p.publish(event)
	delete(p.operations, operationID)
	delete(p.operationUsage, operationID)
	for id, answer := range p.answers {
		if answer.OperationID == operationID {
			delete(p.answers, id)
		}
	}
}

func (p *lifecycleProjector) completeModel(attemptID string, timestamp time.Time, outcome string, usage Usage, errorType string) {
	attempt, found := p.models[attemptID]
	if p.sessionID == "" || !found {
		return
	}
	event := map[string]any{"type": "model.completed", "timestamp": timestamp.Format(time.RFC3339Nano), "sessionId": p.sessionID, "operationId": attempt.OperationID, "operationKind": attempt.Kind, "stepId": attempt.StepID, "attemptId": attemptID, "recovery": attempt.Recovery, "durationMs": lifecycleDuration(attempt.StartedAt, timestamp), "outcome": outcome}
	if usage != (Usage{}) {
		event["usage"] = lifecycleUsageMap(withCacheHitRate(usage))
	}
	if errorType != "" {
		event["errorType"] = errorType
	}
	p.publish(event)
	delete(p.models, attemptID)
	delete(p.usage, attemptID)
}

func (p *lifecycleProjector) completeTool(toolStartedID string, entry map[string]any, timestamp time.Time) {
	attempt, found := p.tools[toolStartedID]
	if p.sessionID == "" || !found {
		return
	}
	result, _ := entry["result"].(map[string]any)
	outcome := "failed"
	if result["type"] == "success" {
		outcome = "succeeded"
	} else if result["reason"] == "interrupted" {
		outcome = "cancelled"
	}
	p.publish(p.toolCompleted(attempt, timestamp, outcome))
	delete(p.tools, toolStartedID)
}

func (p *lifecycleProjector) toolCompleted(attempt lifecycleTool, timestamp time.Time, outcome string) map[string]any {
	return map[string]any{"type": "tool.completed", "timestamp": timestamp.Format(time.RFC3339Nano), "sessionId": p.sessionID, "operationId": attempt.OperationID, "stepId": attempt.StepID, "attemptId": attempt.AttemptID, "parentAttemptId": attempt.ParentAttemptID, "toolStartedId": attempt.ToolStartedID, "toolCallId": attempt.ToolCallID, "tool": attempt.Tool, "recovery": attempt.Recovery, "durationMs": lifecycleDuration(attempt.StartedAt, timestamp), "outcome": outcome}
}

func (p *lifecycleProjector) addOperationUsage(operationID string, usage Usage) {
	current := p.operationUsage[operationID]
	current.Input += usage.Input
	current.Output += usage.Output
	current.CacheRead += usage.CacheRead
	current.CacheWrite += usage.CacheWrite
	current.CacheHitRate = withCacheHitRate(usage).CacheHitRate
	p.operationUsage[operationID] = current
}

func (p *lifecycleProjector) publish(event map[string]any) {
	for _, sink := range p.sinks {
		sink.Emit(event)
	}
}

func lifecycleUsage(value any) (Usage, bool) {
	values, ok := value.(map[string]any)
	if !ok {
		return Usage{}, false
	}
	input, inputOK := numberValue(values["input"])
	output, outputOK := numberValue(values["output"])
	cacheRead, readOK := numberValue(values["cacheRead"])
	cacheWrite, writeOK := numberValue(values["cacheWrite"])
	if !inputOK || !outputOK || !readOK || !writeOK {
		return Usage{}, false
	}
	return Usage{Input: int(input), Output: int(output), CacheRead: int(cacheRead), CacheWrite: int(cacheWrite)}, true
}

func lifecycleUsageMap(usage Usage) map[string]any {
	result := map[string]any{"input": usage.Input, "output": usage.Output, "cacheRead": usage.CacheRead, "cacheWrite": usage.CacheWrite}
	if usage.CacheHitRate != nil {
		result["cacheHitRate"] = *usage.CacheHitRate
	}
	return result
}

func withCacheHitRate(usage Usage) Usage {
	prompt := usage.Input + usage.CacheRead + usage.CacheWrite
	rate := 0.0
	if prompt > 0 {
		rate = float64(usage.CacheRead) / float64(prompt) * 100
	}
	usage.CacheHitRate = &rate
	return usage
}

func lifecycleTime(value any) time.Time {
	switch value := value.(type) {
	case time.Time:
		return value
	case string:
		parsed, err := time.Parse(time.RFC3339Nano, value)
		if err == nil {
			return parsed
		}
	case int64:
		return time.UnixMilli(value).UTC()
	case int:
		return time.UnixMilli(int64(value)).UTC()
	case float64:
		return time.UnixMilli(int64(value)).UTC()
	}
	return time.Now().UTC()
}

func lifecycleTimestamp(event map[string]any) string {
	return lifecycleTime(event["timestamp"]).Format(time.RFC3339Nano)
}
func lifecycleDuration(started, ended time.Time) float64 {
	return max(0, float64(ended.Sub(started).Microseconds())/1000)
}
func stringValue(value any) string { result, _ := value.(string); return result }
func boolValue(value any) bool     { result, _ := value.(bool); return result }
func cloneEvent(event map[string]any) map[string]any {
	result := map[string]any{}
	for key, value := range event {
		result[key] = value
	}
	return result
}
func numberValue(value any) (float64, bool) {
	switch value := value.(type) {
	case int:
		return float64(value), true
	case int64:
		return float64(value), true
	case float64:
		return value, !math.IsNaN(value) && !math.IsInf(value, 0)
	case fmt.Stringer:
		var result float64
		_, err := fmt.Sscan(value.String(), &result)
		return result, err == nil
	}
	return 0, false
}
