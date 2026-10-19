package main

import (
	"slices"
	"testing"
	"time"
)

func TestFactBuildersProduceARunTheReducerAccepts(t *testing.T) {
	inTempDir(t)
	session, err := createSessionStore(time.Now())
	if err != nil {
		t.Fatal(err)
	}
	agent := newAgent(nil, session, "")
	configuration, _, err := agent.currentConfiguration()
	if err != nil {
		t.Fatal(err)
	}
	identity, err := environmentIdentity()
	if err != nil {
		t.Fatal(err)
	}
	tool := &agent.Tools[0]
	usage := Usage{Input: 1, Output: 1}
	commit := func(facts ...map[string]any) {
		t.Helper()
		if err := session.Commit(facts); err != nil {
			t.Fatal(err)
		}
	}
	newID := func() string { return session.NewID(time.Now()) }

	run := durableRun{OperationID: newID(), ContextEntryID: newID(), Attempt: 1}
	commit(userMessageFact(run.ContextEntryID, "inspect"), runStartedFact(run.OperationID, run.ContextEntryID))

	run.StepID, run.AttemptID, run.AssistantEntryID = newID(), newID(), newID()
	toolStartedID, resultEntryID := newID(), newID()
	call := ToolCall{ID: "call_1", Type: "function"}
	call.Function.Name, call.Function.Arguments = tool.Name, "{}"
	commit(stepAttemptFact(run, "assistant", configuration))
	commit(
		assistantMessageFact(run.AssistantEntryID, run.StepID, run.AttemptID, "toolUse", Message{Role: "assistant", ToolCalls: []ToolCall{call}}),
		usageFact(run.OperationID, run.AttemptID, usage),
	)
	commit(toolStartedFact(toolStartedID, run, 0, call, map[string]any{}, tool, identity, resultEntryID))
	commit(toolResultFact(resultEntryID, run.StepID, toolStartedID, tool.Name, toolResultMessage(call.ID, "ok"), "success"))

	run.StepID, run.AttemptID, run.ContextEntryID = newID(), newID(), resultEntryID
	answerID := newID()
	commit(stepAttemptFact(run, "assistant", configuration))
	commit(
		assistantMessageFact(answerID, run.StepID, run.AttemptID, "stop", Message{Role: "assistant", Content: text("done")}),
		usageFact(run.OperationID, run.AttemptID, usage),
	)
	commit(operationFinishedFact(run.OperationID, "run", "completed", operationFinishedExtra{Completion: "normal", FinalEntryID: answerID}))
	if err := session.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, err := openSessionStore(session.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	state := reopened.State()
	if state.Operation.Kind != "idle" {
		t.Fatalf("operation: %+v", state.Operation)
	}
	roles := []string{}
	for _, message := range state.Transcript {
		roles = append(roles, message["role"].(string))
	}
	if !slices.Equal(roles, []string{"user", "assistant", "tool", "assistant"}) {
		t.Fatalf("roles: %v", roles)
	}
}
