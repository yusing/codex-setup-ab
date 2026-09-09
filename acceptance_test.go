package router

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestABAcceptanceFullTransformedToolDetails(t *testing.T) {
	readPath := strings.Repeat("r", 280) + "-read-tail.txt"
	readArguments := `{"cmd":` + string(acceptanceJSON(t, "cat "+readPath)) + `}`
	read := subagentToolActivityText(map[string]json.RawMessage{
		"name":      acceptanceJSON(t, "exec_command"),
		"arguments": acceptanceJSON(t, readArguments),
	}, "exec_command")
	if !strings.Contains(read, "Read") || !strings.Contains(read, readPath) {
		t.Fatalf("long classified read was shortened: %q", read)
	}

	query := strings.Repeat("q", 280) + "-search-tail"
	searchArguments := `{"cmd":` + string(acceptanceJSON(t, "hgrep -F '"+query+"' search-target.txt")) + `}`
	search := subagentToolActivityText(map[string]json.RawMessage{
		"name":      acceptanceJSON(t, "exec_command"),
		"arguments": acceptanceJSON(t, searchArguments),
	}, "exec_command")
	if !strings.Contains(search, "Search") || !strings.Contains(search, query) || !strings.Contains(search, "search-target.txt") {
		t.Fatalf("long classified search was shortened: %q", search)
	}

	spacedQuery := "needle" + strings.Repeat(" ", 4200) + "whitespace-tail"
	largeSource := toolActivityShell("hgrep -F '" + spacedQuery + "' final-target.txt\ncat final-read.txt")
	acceptanceRequireOrdered(t, largeSource, "Search", "whitespace-tail", "final-target.txt", "Read", "final-read.txt")

	var commands []string
	var ordered []string
	for i := range 5 {
		path := fmt.Sprintf("classified-%d-%s-tail.txt", i, strings.Repeat(string(rune('a'+i)), 90))
		commands = append(commands, "cat "+path)
		ordered = append(ordered, path)
	}
	classified := toolActivityShell(strings.Join(commands, "\n"))
	acceptanceRequireOrdered(t, classified, ordered...)
}

func TestABAcceptanceGroupsSamePathWithNestedActions(t *testing.T) {
	a := newSubagentActivity()
	acceptanceObserveRootAndChild(t, a, "root", "child", "/root/research")
	a.collect("child", "read", "tool", toolActivityShell("cat notes.txt"))
	a.collect("child", "search", "tool", toolActivityShell("hgrep -n needle notes.txt"))

	messages := a.drain("root", time.Now(), maxCommentaryPublicationBytes)
	if len(messages) != 1 {
		t.Fatalf("same-path actions should share one group, got %d messages", len(messages))
	}
	text := acceptanceMessageText(t, messages[0])
	acceptanceRequireOneHeading(t, text, "/root/research")
	acceptanceRequireNestedAction(t, text, "Read", "notes.txt")
	acceptanceRequireNestedAction(t, text, "Search", "needle")
	acceptanceRequireOrdered(t, text, "Read", "notes.txt", "Search", "needle")
}

func TestABAcceptanceGroupingRespectsChildNoticeAndDeferredBoundaries(t *testing.T) {
	a := newSubagentActivity()
	if !a.observe("root", "", "/root", false) ||
		!a.observe("child-a", "root", "/root/a", true) ||
		!a.observe("child-b", "root", "/root/b", true) {
		t.Fatal("failed to establish activity ancestry")
	}
	a.collect("child-a", "a-read", "tool", toolActivityShell("cat a.txt"))
	a.collect("child-a", "a-search", "tool", toolActivityShell("hgrep term a.txt"))
	a.collect("child-b", "b-read", "tool", toolActivityShell("cat b.txt"))
	a.collect("child-a", "a-after-child", "tool", toolActivityShell("cat c.txt"))
	a.collect("child-a", "notice", "reply", "reply boundary")
	a.collect("child-a", "a-after-notice", "tool", toolActivityShell("hgrep later c.txt"))

	messages := a.drain("root", time.Now(), maxCommentaryPublicationBytes)
	if len(messages) != 5 {
		t.Fatalf("group crossed a child or notice boundary: got %d messages", len(messages))
	}
	texts := acceptanceTexts(t, messages)
	acceptanceRequireOrdered(t, texts[0], "a.txt", "Search", "term")
	if strings.Contains(texts[0], "b.txt") || strings.Contains(texts[0], "c.txt") {
		t.Fatalf("first group crossed a boundary: %q", texts[0])
	}
	if !strings.Contains(texts[1], "/root/b") || !strings.Contains(texts[1], "b.txt") {
		t.Fatalf("child boundary was not preserved: %q", texts[1])
	}
	if !strings.Contains(texts[2], "/root/a") || !strings.Contains(texts[2], "c.txt") ||
		!strings.Contains(texts[3], "reply boundary") || !strings.Contains(texts[4], "later") {
		t.Fatalf("notice ordering was not preserved: %#v", texts)
	}

	b := newSubagentActivity()
	acceptanceObserveRootAndChild(t, b, "root", "child", "/root/a")
	b.collect("child", "deferred", "tool", toolActivityShell("cat deferred.txt"))
	started := time.Now()
	b.collect("child", "current", "tool", toolActivityShell("hgrep current current.txt"))
	deferred := b.drain("root", started, maxCommentaryPublicationBytes)
	if len(deferred) != 2 {
		t.Fatalf("deferred/current calls were merged: got %d messages", len(deferred))
	}
	deferredTexts := acceptanceTexts(t, deferred)
	if !strings.Contains(deferredTexts[0], "since the last update") || strings.Contains(deferredTexts[1], "since the last update") {
		t.Fatalf("deferred boundary labels were lost: %#v", deferredTexts)
	}
}

func TestABAcceptanceGroupedMultilineDetailsPreserveIndentation(t *testing.T) {
	a := newSubagentActivity()
	acceptanceObserveRootAndChild(t, a, "root", "child", "/root/code")
	a.collect("child", "one", "tool", toolActivityShell("echo first\n  echo nested-first"))
	a.collect("child", "two", "tool", toolActivityShell("echo second\n    echo nested-second"))

	messages := a.drain("root", time.Now(), maxCommentaryPublicationBytes)
	if len(messages) != 1 {
		t.Fatalf("multiline calls should share one group, got %d messages", len(messages))
	}
	text := acceptanceMessageText(t, messages[0])
	acceptanceRequireOneHeading(t, text, "/root/code")
	acceptanceRequireRelativeIndent(t, text, "echo first", "echo nested-first", 2)
	acceptanceRequireRelativeIndent(t, text, "echo second", "echo nested-second", 4)
	if strings.Count(text, "```") < 4 {
		t.Fatalf("multiline details lost their fenced blocks: %q", text)
	}
}

func TestABAcceptanceGroupingHonorsBudgetAndRetainsRemainder(t *testing.T) {
	firstDetail := "first-" + strings.Repeat("a", 80)
	secondDetail := "second-" + strings.Repeat("b", 80)

	probe := newSubagentActivity()
	acceptanceObserveRootAndChild(t, probe, "root", "child", "/root/budget")
	probe.collect("child", "first", "tool", toolActivityShell("cat "+firstDetail))
	probeMessages := probe.drain("root", time.Now(), maxCommentaryPublicationBytes)
	if len(probeMessages) != 1 {
		t.Fatalf("could not determine one-message budget: %d", len(probeMessages))
	}
	budget := len(acceptanceMessageText(t, probeMessages[0]))

	a := newSubagentActivity()
	acceptanceObserveRootAndChild(t, a, "root", "child", "/root/budget")
	a.collect("child", "first", "tool", toolActivityShell("cat "+firstDetail))
	a.collect("child", "second", "tool", toolActivityShell("cat "+secondDetail))
	delivered := a.drain("root", time.Now(), budget)
	if len(delivered) != 1 {
		t.Fatalf("budget should deliver the first ready action, got %d messages", len(delivered))
	}
	firstText := acceptanceMessageText(t, delivered[0])
	if len(firstText) > budget || !strings.Contains(firstText, firstDetail) || strings.Contains(firstText, secondDetail) {
		t.Fatalf("first delivery violated its byte budget: len=%d budget=%d text=%q", len(firstText), budget, firstText)
	}
	remaining := a.drain("root", time.Now(), maxCommentaryPublicationBytes)
	if len(remaining) != 1 || !strings.Contains(acceptanceMessageText(t, remaining[0]), secondDetail) {
		t.Fatalf("undelivered action was lost: %#v", acceptanceTexts(t, remaining))
	}
}

func TestABAcceptanceSourceDedupAndReplayStripping(t *testing.T) {
	a := newSubagentActivity()
	acceptanceObserveRootAndChild(t, a, "root", "child", "/root/replay")
	a.collect("child", "stable-source", "tool", toolActivityShell("cat replay.txt"))
	a.collect("child", "stable-source", "tool", toolActivityShell("cat duplicate.txt"))
	delivered := a.drain("root", time.Now(), maxCommentaryPublicationBytes)
	if len(delivered) != 1 || !strings.Contains(acceptanceMessageText(t, delivered[0]), "replay.txt") {
		t.Fatalf("source identity was not deduplicated: %#v", acceptanceTexts(t, delivered))
	}
	a.collect("child", "stable-source", "tool", toolActivityShell("cat replay-again.txt"))
	if repeated := a.drain("root", time.Now(), maxCommentaryPublicationBytes); len(repeated) != 0 {
		t.Fatalf("delivered source replayed: %#v", acceptanceTexts(t, repeated))
	}

	original := map[string]json.RawMessage{
		"id":      acceptanceJSON(t, "original-child-message"),
		"type":    acceptanceJSON(t, "message"),
		"role":    acceptanceJSON(t, "assistant"),
		"content": acceptanceJSON(t, []map[string]string{{"type": "output_text", "text": "original"}}),
	}
	fields := map[string]json.RawMessage{"input": acceptanceJSON(t, append(delivered, original))}
	a.stripInput(fields)
	var remaining []map[string]json.RawMessage
	if err := json.Unmarshal(fields["input"], &remaining); err != nil {
		t.Fatal(err)
	}
	if len(remaining) != 1 || acceptanceRawString(remaining[0]["id"]) != "original-child-message" {
		t.Fatalf("stripInput removed original history or retained a root copy: %s", fields["input"])
	}
}

func TestABAcceptanceImmediateDeliveryAndCompleteSamePathGroup(t *testing.T) {
	a := newSubagentActivity()
	acceptanceObserveRootAndChild(t, a, "root", "child", "/root/immediate")
	a.collect("child", "single", "tool", toolActivityShell("cat single.txt"))
	if got := a.drain("root", time.Now(), maxCommentaryPublicationBytes); len(got) != 1 {
		t.Fatalf("single call was held waiting for a group: %d messages", len(got))
	}

	for i := range 4 {
		a.collect("child", fmt.Sprintf("cap-%d", i), "tool", toolActivityShell(fmt.Sprintf("cat cap-%d.txt", i)))
	}
	messages := a.drain("root", time.Now(), maxCommentaryPublicationBytes)
	if len(messages) != 1 {
		t.Fatalf("all ready same-path calls should share one group, got %d messages: %#v", len(messages), acceptanceTexts(t, messages))
	}
	text := acceptanceMessageText(t, messages[0])
	acceptanceRequireOrdered(t, text, "cap-0.txt", "cap-1.txt", "cap-2.txt", "cap-3.txt")
	for i := range 4 {
		detail := fmt.Sprintf("cap-%d.txt", i)
		if strings.Count(text, detail) != 1 {
			t.Fatalf("source action %q was lost or repeated in %q", detail, text)
		}
	}
}

func acceptanceObserveRootAndChild(t *testing.T, a *subagentActivity, root, child, path string) {
	t.Helper()
	if !a.observe(root, "", "/root", false) || !a.observe(child, root, path, true) {
		t.Fatal("failed to establish activity ancestry")
	}
}

func acceptanceMessageText(t *testing.T, message map[string]json.RawMessage) string {
	t.Helper()
	var content []struct {
		Text string `json:"text"`
	}
	if err := json.Unmarshal(message["content"], &content); err != nil || len(content) != 1 {
		t.Fatalf("invalid commentary message content: %s (%v)", message["content"], err)
	}
	return content[0].Text
}

func acceptanceTexts(t *testing.T, messages []map[string]json.RawMessage) []string {
	t.Helper()
	texts := make([]string, len(messages))
	for i := range messages {
		texts[i] = acceptanceMessageText(t, messages[i])
	}
	return texts
}

func acceptanceRequireOrdered(t *testing.T, text string, parts ...string) {
	t.Helper()
	offset := 0
	for _, part := range parts {
		index := strings.Index(text[offset:], part)
		if index < 0 {
			t.Fatalf("%q is missing or out of order in %q", part, text)
		}
		offset += index + len(part)
	}
}

func acceptanceRequireOneHeading(t *testing.T, text, path string) {
	t.Helper()
	count := 0
	for _, line := range strings.Split(text, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "In ") && strings.Contains(trimmed, path) {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("wanted one In heading for %s, got %d in %q", path, count, text)
	}
}

func acceptanceRequireNestedAction(t *testing.T, text, label, detail string) {
	t.Helper()
	lines := strings.Split(text, "\n")
	labelLine, labelIndent := -1, -1
	for i, line := range lines {
		indent, body, ok := acceptanceBullet(line)
		if ok && strings.HasPrefix(body, label) {
			labelLine, labelIndent = i, indent
			break
		}
	}
	if labelLine < 0 {
		t.Fatalf("missing %s action bullet in %q", label, text)
	}
	if _, body, _ := acceptanceBullet(lines[labelLine]); strings.Contains(body, detail) {
		return
	}
	for _, line := range lines[labelLine+1:] {
		indent, body, ok := acceptanceBullet(line)
		if ok && indent <= labelIndent {
			break
		}
		if ok && indent > labelIndent && strings.Contains(body, detail) {
			return
		}
	}
	t.Fatalf("%s detail %q is not a nested bullet in %q", label, detail, text)
}

func acceptanceBullet(line string) (indent int, body string, ok bool) {
	for _, r := range line {
		switch r {
		case ' ':
			indent++
		case '\t':
			indent += 4
		default:
			trimmed := strings.TrimLeft(line, " \t")
			if strings.HasPrefix(trimmed, "- ") || strings.HasPrefix(trimmed, "* ") {
				return indent, strings.TrimSpace(trimmed[2:]), true
			}
			return 0, "", false
		}
	}
	return 0, "", false
}

func acceptanceRequireRelativeIndent(t *testing.T, text, parent, child string, extra int) {
	t.Helper()
	lines := strings.Split(text, "\n")
	for i, line := range lines {
		if strings.TrimSpace(line) != parent || i+1 >= len(lines) || strings.TrimSpace(lines[i+1]) != child {
			continue
		}
		if acceptanceLeadingSpace(lines[i+1])-acceptanceLeadingSpace(line) < extra {
			t.Fatalf("indentation within multiline detail changed: %q then %q", line, lines[i+1])
		}
		return
	}
	t.Fatalf("multiline detail %q / %q not found intact in %q", parent, child, text)
}

func acceptanceLeadingSpace(line string) int {
	n := 0
	for _, r := range line {
		if r == ' ' {
			n++
		} else if r == '\t' {
			n += 4
		} else {
			break
		}
	}
	return n
}

func acceptanceJSON(t *testing.T, value any) json.RawMessage {
	t.Helper()
	b, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func acceptanceRawString(raw json.RawMessage) string {
	var value string
	_ = json.Unmarshal(raw, &value)
	return value
}
