package router

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
	"unicode/utf8"
)

// Exercise the existing request/response boundary rather than solution-only helpers.
func abShellActivity(t *testing.T, history []any, source string, stored string, stream bool) string {
	t.Helper()
	proxy := newManagedHPatchProxy(t, testTranslator(t, new(int)))
	root, _ := prepareActivityTest(t, proxy, "ab-root", "ab-root-thread", "", "/root", nil)
	child, _ := prepareActivityTest(t, proxy, "ab-child", "ab-child-thread", "ab-root-thread", "/root/worker", history)
	if stored != "" {
		if _, ok := proxy.retainShell(child.shellDirectory, "ab-stored", stored); !ok {
			t.Fatal("could not retain evaluator script")
		}
	}
	name := "exec"
	if strings.HasPrefix(source, "#!") {
		name = "shell"
	}
	call := map[string]any{"type": "custom_tool_call", "id": "ab-action", "call_id": "ab-action", "name": name, "input": source}
	response := mustTestJSON(t, map[string]any{"status": "completed", "output": []any{call}})
	if stream {
		if _, err := child.TransformSSE(mustTestJSON(t, map[string]any{"type": "response.output_item.done", "item": call})); err != nil {
			t.Fatal(err)
		}
		if _, err := child.TransformSSE(mustTestJSON(t, map[string]any{"type": "response.completed", "response": json.RawMessage(response)})); err != nil {
			t.Fatal(err)
		}
		events, err := root.TransformSSE([]byte(`{"type":"response.completed","response":{"status":"completed","output":[]}}`))
		if err != nil {
			t.Fatal(err)
		}
		return string(bytes.Join(events, nil))
	}
	if _, err := child.TransformJSON(response); err != nil {
		t.Fatal(err)
	}
	result, err := root.TransformJSON([]byte(`{"status":"completed","output":[]}`))
	if err != nil {
		t.Fatal(err)
	}
	return string(result)
}

func abRunningHistory(command string) []any {
	return []any{
		map[string]any{"type": "function_call", "call_id": "ab-run", "name": "exec_command", "arguments": string(mustMarshalJSON(map[string]any{"cmd": command}))},
		map[string]any{"type": "function_call_output", "call_id": "ab-run", "output": "Chunk ID: ab\nWall time: 1 seconds\nProcess running with session ID 80421\nFinal output:\n"},
	}
}

func TestABAcceptanceRunningAndStoredActivity(t *testing.T) {
	for _, stream := range []bool{false, true} {
		t.Run(map[bool]string{false: "json", true: "sse"}[stream], func(t *testing.T) {
			for _, tc := range []struct {
				label, source, stored string
				history               []any
			}{
				{"Still Running", `text(await tools.write_stdin({session_id:80421,chars:""}));`, "", abRunningHistory("go test ./internal/router\nprintf secret-tail")},
				{"Running stored script", "#!script=@shell/ab-stored", "go test ./internal/router\nprintf secret-tail", nil},
			} {
				got := abShellActivity(t, tc.history, tc.source, tc.stored, stream)
				for _, want := range []string{tc.label, "go test ./internal/router…"} {
					if !strings.Contains(got, want) {
						t.Errorf("missing %q: %s", want, got)
					}
				}
				for _, hidden := range []string{"80421", "@shell/", "secret-tail", "command unavailable"} {
					if strings.Contains(got, hidden) {
						t.Errorf("opaque or full command detail %q: %s", hidden, got)
					}
				}
			}
		})
	}
}

func TestABAcceptanceMissingSourceAndNonemptyInput(t *testing.T) {
	for _, source := range []string{
		`text(await tools.write_stdin({session_id:80421,chars:""}));`,
		"#!script=@shell/ab-missing",
	} {
		got := abShellActivity(t, nil, source, "", false)
		if !strings.Contains(got, "command unavailable") || strings.Contains(got, "80421") || strings.Contains(got, "@shell/") {
			t.Fatalf("missing source must be explicit: %s", got)
		}
	}
	got := abShellActivity(t, abRunningHistory("sleep 20"), `text(await tools.write_stdin({session_id:80421,chars:"yes\n"}));`, "", false)
	if !strings.Contains(got, "Send input") || strings.Contains(got, "Still Running") {
		t.Fatalf("input must not be mislabeled as a wait: %s", got)
	}
}

func TestABAcceptanceNoProgramOutputCorrelation(t *testing.T) {
	history := abRunningHistory("sleep 45")
	history = append(history,
		map[string]any{"type": "custom_tool_call", "call_id": "ab-stdout", "name": "exec", "input": `const r = await tools.exec_command({cmd:"printf misleading"}); text(r.output);`},
		map[string]any{"type": "custom_tool_call_output", "call_id": "ab-stdout", "output": "Process running with session ID 80421"},
	)
	got := abShellActivity(t, history, `text(await tools.write_stdin({session_id:80421,chars:""}));`, "", false)
	if !strings.Contains(got, "sleep 45") || strings.Contains(got, "printf misleading") {
		t.Fatalf("stdout must not replace correlated execution metadata: %s", got)
	}
}

func TestABAcceptanceUnicodeExcerptBound(t *testing.T) {
	command := strings.Repeat("界", 121)
	got := abShellActivity(t, nil, "#!script=@shell/ab-stored", command, false)
	if !utf8.ValidString(got) || !strings.Contains(got, strings.Repeat("界", 119)+"…") || strings.Contains(got, strings.Repeat("界", 120)) {
		t.Fatalf("excerpt must preserve Unicode within 120 characters: %s", got)
	}
}

