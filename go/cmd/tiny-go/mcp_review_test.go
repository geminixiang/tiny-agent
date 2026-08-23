package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type testRoundTripper func(*http.Request) (*http.Response, error)

func (f testRoundTripper) RoundTrip(request *http.Request) (*http.Response, error) { return f(request) }

func TestMCPNegotiationGuardClearsLegacyPermission(t *testing.T) {
	calls := []string{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var q struct {
			ID     int    `json:"id"`
			Method string `json:"method"`
		}
		_ = json.NewDecoder(r.Body).Decode(&q)
		calls = append(calls, q.Method)
		if len(calls) == 1 {
			writeRPCError(w, q.ID, -32601, nil)
			return
		}
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer server.Close()
	guard := mcpLifecycleTransport{base: server.Client().Transport, state: &mcpLifecycleState{}}
	request := func(method string) *http.Request {
		r, _ := http.NewRequest(http.MethodPost, server.URL, strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"`+method+`"}`))
		return r
	}
	for _, method := range []string{"server/discover", "server/discover"} {
		response, err := guard.RoundTrip(request(method))
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
	}
	if _, err := guard.RoundTrip(request("initialize")); err == nil {
		t.Fatal("initialize was not blocked")
	}
	if strings.Join(calls, ",") != "server/discover,server/discover" {
		t.Fatalf("calls=%v", calls)
	}
}
