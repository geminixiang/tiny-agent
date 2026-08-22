package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestSessionV2GoldenFixtures(t *testing.T) {
	root, err := findRepositoryRoot()
	if err != nil {
		t.Fatal(err)
	}
	fixtures := filepath.Join(root, "schemas", "session-v2", "fixtures")
	var manifest struct {
		Fixtures []struct {
			Name, File, Expected string
		} `json:"fixtures"`
	}
	readJSONFile(t, filepath.Join(fixtures, "manifest.json"), &manifest)
	if len(manifest.Fixtures) != 24 {
		t.Fatalf("fixture count = %d, want 24", len(manifest.Fixtures))
	}
	for _, fixture := range manifest.Fixtures {
		t.Run(fixture.Name, func(t *testing.T) {
			data, err := os.ReadFile(filepath.Join(fixtures, fixture.File))
			if err != nil {
				t.Fatal(err)
			}
			var expected struct {
				OK    bool                 `json:"ok"`
				State json.RawMessage      `json:"state"`
				Error *sessionV2Corruption `json:"error"`
			}
			readJSONFile(t, filepath.Join(fixtures, fixture.Expected), &expected)
			state, reduceErr := reduceSessionV2(data)
			if expected.OK {
				if reduceErr != nil {
					t.Fatal(reduceErr)
				}
				var expectedState any
				if err := json.Unmarshal(expected.State, &expectedState); err != nil {
					t.Fatal(err)
				}
				assertSameJSON(t, expectedState, state)
				return
			}
			var corruption *sessionV2Corruption
			if !errors.As(reduceErr, &corruption) {
				t.Fatalf("error = %v, want corruption", reduceErr)
			}
			assertSameJSON(t, expected.Error, corruption)
		})
	}
}

func findRepositoryRoot() (string, error) {
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "schemas", "session-v2", "fixtures", "manifest.json")); err == nil {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", os.ErrNotExist
		}
		dir = parent
	}
}

func readJSONFile(t *testing.T, path string, target any) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, target); err != nil {
		t.Fatal(err)
	}
}

func assertSameJSON(t *testing.T, want, got any) {
	t.Helper()
	expected, err := json.Marshal(want)
	if err != nil {
		t.Fatal(err)
	}
	actual, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	var expectedValue, actualValue any
	if err := json.Unmarshal(expected, &expectedValue); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(actual, &actualValue); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(actualValue, expectedValue) {
		t.Fatalf("\nwant %s\n got %s", expected, actual)
	}
}
