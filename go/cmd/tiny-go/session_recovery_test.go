package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestSessionRecoveryPlannerFixtures(t *testing.T) {
	root, err := findRepositoryRoot()
	if err != nil {
		t.Fatal(err)
	}
	directory := filepath.Join(root, "schemas", "session", "planner-fixtures")
	var manifest struct {
		Fixtures []struct {
			Name, Input, Expected string
		} `json:"fixtures"`
	}
	readJSONFile(t, filepath.Join(directory, "manifest.json"), &manifest)
	if len(manifest.Fixtures) == 0 {
		t.Fatal("planner fixture manifest is empty")
	}
	for _, fixture := range manifest.Fixtures {
		t.Run(fixture.Name, func(t *testing.T) {
			var input struct {
				SessionFile string               `json:"sessionFile"`
				Current     currentConfiguration `json:"current"`
			}
			readJSONFile(t, filepath.Join(directory, fixture.Input), &input)
			data, err := os.ReadFile(filepath.Join(root, "schemas", "session", "fixtures", input.SessionFile))
			if err != nil {
				t.Fatal(err)
			}
			state, err := reduceSession(data)
			if err != nil {
				t.Fatal(err)
			}
			var expected any
			readJSONFile(t, filepath.Join(directory, fixture.Expected), &expected)
			actual := planRecovery(state, input.Current)
			encoded, err := json.Marshal(actual)
			if err != nil {
				t.Fatal(err)
			}
			var normalized any
			if err := json.Unmarshal(encoded, &normalized); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(normalized, expected) {
				want, _ := json.Marshal(expected)
				t.Fatalf("\nwant %s\n got %s", want, encoded)
			}
		})
	}
}
