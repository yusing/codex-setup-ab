package main

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

type abBundleCLI struct {
	prefix                    []string
	payloadPrefix             string
	createStyle, extractStyle int
}

func abBundleArgs(prefix []string, operation string, style int, source, destination string) []string {
	args := append(append([]string{}, prefix...), operation)
	if operation == "verify" {
		return append(args, source)
	}
	switch style {
	case 1:
		return append(args, source, "--output", destination)
	case 2:
		return append(args, "--output", destination, source)
	case 3:
		return append(args, destination, source)
	default:
		return append(args, source, destination)
	}
}
func abBundleWrite(t *testing.T, path string, data []byte, mode os.FileMode) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, mode); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, mode); err != nil {
		t.Fatal(err)
	}
}
func abBundleRead(t *testing.T, path string) []byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return data
}
func abBundleSource(t *testing.T) string {
	t.Helper()
	root := filepath.Join(t.TempDir(), "example")
	abBundleWrite(t, filepath.Join(root, "SKILL.md"), []byte("---\nname: example\ndescription: A fixture\n---\n# Example\n"), 0o644)
	abBundleWrite(t, filepath.Join(root, "references/guide.txt"), []byte("guide\n"), 0o644)
	abBundleWrite(t, filepath.Join(root, "scripts/run.sh"), []byte("#!/bin/sh\necho example\n"), 0o755)
	abBundleWrite(t, filepath.Join(root, "assets/binary"), []byte{0, 255, 13, 10, 42}, 0o644)
	return root
}

// A bundle may contain a single skill directly or preserve its named root.
func abBundlePayloadRoot(destination string) (string, bool) {
	var roots []string
	err := filepath.WalkDir(destination, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.Type().IsRegular() && entry.Name() == "SKILL.md" {
			roots = append(roots, filepath.Dir(path))
		}
		return nil
	})
	if err != nil || len(roots) != 1 {
		return "", false
	}
	relative, err := filepath.Rel(destination, roots[0])
	return relative, err == nil
}

func abBundleSetup(t *testing.T) abBundleCLI {
	t.Helper()
	taskHome := t.TempDir()
	t.Setenv("HOME", taskHome)
	t.Setenv("XDG_CACHE_HOME", filepath.Join(taskHome, "cache"))
	t.Setenv("CODEX_HOME", filepath.Join(taskHome, "codex"))
	t.Chdir(t.TempDir())
	original := startBackgroundRefresh
	startBackgroundRefresh = func(*manager, *os.File) error { return nil }
	t.Cleanup(func() { startBackgroundRefresh = original })
	source := abBundleSource(t)
	// The prompt leaves CLI shape open. Probe common forms rather than impose a private ABI.
	for _, prefix := range [][]string{{"bundle"}, {"bundles"}, {}} {
		for style := range 4 {
			archive := filepath.Join(t.TempDir(), "fixture.tar.gz")
			if err := run(abBundleArgs(prefix, "create", style, source, archive)); err != nil {
				continue
			}
			if _, err := os.Stat(archive); err != nil {
				continue
			}
			if err := run(abBundleArgs(prefix, "verify", 0, archive, "")); err != nil {
				continue
			}
			for extractStyle := range 3 {
				dest := filepath.Join(t.TempDir(), "extracted")
				if err := run(abBundleArgs(prefix, "extract", extractStyle, archive, dest)); err == nil {
					if payloadPrefix, ok := abBundlePayloadRoot(dest); ok {
						return abBundleCLI{prefix: prefix, createStyle: style, extractStyle: extractStyle, payloadPrefix: payloadPrefix}
					}
				}
			}
		}
	}
	t.Fatal("EVALUATOR_INTERFACE_UNSUPPORTED: no working round trip in supported CLI shapes; inspect candidate help before classifying as product failure")
	return abBundleCLI{}
}
func (cli abBundleCLI) args(operation, source, destination string) []string {
	style := cli.createStyle
	if operation == "extract" {
		style = cli.extractStyle
	}
	return abBundleArgs(cli.prefix, operation, style, source, destination)
}
func TestABAcceptanceBundleRoundTrip(t *testing.T) {
	cli := abBundleSetup(t)
	source := abBundleSource(t)
	archive := filepath.Join(t.TempDir(), "skill.tar.gz")
	if err := run(cli.args("create", source, archive)); err != nil {
		t.Fatal(err)
	}
	if err := run(cli.args("verify", archive, "")); err != nil {
		t.Fatal(err)
	}
	dest := filepath.Join(t.TempDir(), "restored")
	if err := run(cli.args("extract", archive, dest)); err != nil {
		t.Fatal(err)
	}
	dest = filepath.Join(dest, cli.payloadPrefix)
	for _, path := range []string{"SKILL.md", "references/guide.txt", "scripts/run.sh", "assets/binary"} {
		if !bytes.Equal(abBundleRead(t, filepath.Join(source, path)), abBundleRead(t, filepath.Join(dest, path))) {
			t.Errorf("content differs for %s", path)
		}
	}
	info, err := os.Stat(filepath.Join(dest, "scripts/run.sh"))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm()&0o111 == 0 {
		t.Error("executable script lost execute bits")
	}
}
func TestABAcceptanceBundleReproducible(t *testing.T) {
	cli := abBundleSetup(t)
	first, second := abBundleSource(t), abBundleSource(t)
	if err := filepath.WalkDir(second, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		return os.Chtimes(path, time.Unix(1234, 0), time.Unix(5678, 0))
	}); err != nil {
		t.Fatal(err)
	}
	a, b := filepath.Join(t.TempDir(), "a.tar.gz"), filepath.Join(t.TempDir(), "b.tar.gz")
	if err := run(cli.args("create", first, a)); err != nil {
		t.Fatal(err)
	}
	if err := run(cli.args("create", second, b)); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(abBundleRead(t, a), abBundleRead(t, b)) {
		t.Error("equivalent contents/modes produced different archive bytes")
	}
}
func TestABAcceptanceBundleCorruption(t *testing.T) {
	cli := abBundleSetup(t)
	archive := filepath.Join(t.TempDir(), "original.tar.gz")
	if err := run(cli.args("create", abBundleSource(t), archive)); err != nil {
		t.Fatal(err)
	}
	data := abBundleRead(t, archive)
	if len(data) < 16 {
		t.Fatal("archive unexpectedly short")
	}
	flipped := bytes.Clone(data)
	switch {
	case data[0] == 0x1f && data[1] == 0x8b:
		// Corrupt the gzip checksum, not potentially unprotected metadata.
		flipped[len(flipped)-8] ^= 0xff
	case data[0] == 'P' && data[1] == 'K':
		reader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
		if err != nil {
			t.Fatal(err)
		}
		found := false
		for _, file := range reader.File {
			if file.CompressedSize64 == 0 {
				continue
			}
			offset, err := file.DataOffset()
			if err != nil {
				t.Fatal(err)
			}
			flipped[offset] ^= 0xff
			found = true
			break
		}
		if !found {
			t.Fatal("EVALUATOR_FORMAT_UNSUPPORTED: no protected ZIP payload")
		}
	default:
		t.Fatal("EVALUATOR_FORMAT_UNSUPPORTED: corruption probe supports ZIP and gzip")
	}
	for i, bad := range [][]byte{data[:len(data)/2], flipped} {
		root := t.TempDir()
		path := filepath.Join(root, "corrupt.tar.gz")
		abBundleWrite(t, path, bad, 0o644)
		if err := run(cli.args("verify", path, "")); err == nil {
			t.Errorf("verify accepted corruption %d", i)
		}
		if err := run(cli.args("extract", path, filepath.Join(root, "output"))); err == nil {
			t.Errorf("extract accepted corruption %d", i)
		}
	}
}

// Mutate candidate-created ZIP/tar.gz bundles without assuming a manifest schema.
func abBundleRewrite(data []byte) ([]byte, error) {
	var out bytes.Buffer
	if len(data) > 2 && data[0] == 'P' && data[1] == 'K' {
		reader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
		if err != nil {
			return nil, err
		}
		writer := zip.NewWriter(&out)
		changed := false
		for _, file := range reader.File {
			input, err := file.Open()
			if err != nil {
				return nil, err
			}
			body, err := io.ReadAll(io.LimitReader(input, 2<<20))
			input.Close()
			if err != nil {
				return nil, err
			}
			header := file.FileHeader
			if strings.HasSuffix(header.Name, "SKILL.md") && !changed {
				header.Name = "../escape"
				changed = true
			}
			output, err := writer.CreateHeader(&header)
			if err != nil {
				return nil, err
			}
			if _, err = output.Write(body); err != nil {
				return nil, err
			}
		}
		if !changed {
			return nil, fmt.Errorf("no SKILL.md payload found")
		}
		if err := writer.Close(); err != nil {
			return nil, err
		}
		return out.Bytes(), nil
	}
	gz, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("EVALUATOR_FORMAT_UNSUPPORTED: %w", err)
	}
	defer gz.Close()
	reader := tar.NewReader(gz)
	zipper := gzip.NewWriter(&out)
	writer := tar.NewWriter(zipper)
	changed := false
	for {
		header, err := reader.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
		body, err := io.ReadAll(io.LimitReader(reader, 2<<20))
		if err != nil {
			return nil, err
		}
		if strings.HasSuffix(header.Name, "SKILL.md") && !changed {
			header.Name = "../escape"
			changed = true
		}
		header.Size = int64(len(body))
		if err := writer.WriteHeader(header); err != nil {
			return nil, err
		}
		if _, err := writer.Write(body); err != nil {
			return nil, err
		}
	}
	if !changed {
		return nil, fmt.Errorf("EVALUATOR_FORMAT_UNSUPPORTED: no SKILL.md payload")
	}
	if err := writer.Close(); err != nil {
		return nil, err
	}
	if err := zipper.Close(); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}
func TestABAcceptanceBundleUnsafeArchives(t *testing.T) {
	cli := abBundleSetup(t)
	archive := filepath.Join(t.TempDir(), "original.tar.gz")
	if err := run(cli.args("create", abBundleSource(t), archive)); err != nil {
		t.Fatal(err)
	}
	for _, mutation := range []string{"traversal"} {
		t.Run(mutation, func(t *testing.T) {
			rewritten, err := abBundleRewrite(abBundleRead(t, archive))
			if err != nil {
				t.Fatalf("EVALUATOR_FORMAT_UNSUPPORTED: %v; requires manual coverage, not a product-failure conclusion", err)
			}
			root := t.TempDir()
			path := filepath.Join(root, "bad.tar.gz")
			abBundleWrite(t, path, rewritten, 0o644)
			if err := run(cli.args("verify", path, "")); err == nil {
				t.Errorf("verify accepted %s mutation", mutation)
			}
			if err := run(cli.args("extract", path, filepath.Join(root, "output"))); err == nil {
				t.Errorf("extract accepted %s mutation", mutation)
			}
			if _, err := os.Stat(filepath.Join(root, "escape")); !os.IsNotExist(err) {
				t.Error("archive wrote outside destination")
			}
		})
	}
}
func TestABAcceptanceBundleNoOverwrite(t *testing.T) {
	cli := abBundleSetup(t)
	source := abBundleSource(t)
	root := t.TempDir()
	archive := filepath.Join(root, "existing.tar.gz")
	abBundleWrite(t, archive, []byte("preserve"), 0o644)
	_ = run(cli.args("create", source, archive))
	if string(abBundleRead(t, archive)) != "preserve" {
		t.Error("existing archive destroyed")
	}
	valid := filepath.Join(root, "valid.tar.gz")
	if err := run(cli.args("create", source, valid)); err != nil {
		t.Fatal(err)
	}
	dest := filepath.Join(root, "existing")
	abBundleWrite(t, filepath.Join(dest, cli.payloadPrefix, "SKILL.md"), []byte("preserve"), 0o644)
	_ = run(cli.args("extract", valid, dest))
	if string(abBundleRead(t, filepath.Join(dest, cli.payloadPrefix, "SKILL.md"))) != "preserve" {
		t.Error("existing extracted file destroyed")
	}
}

// Subprocesses expose publication races that a process-local mutex can hide.
func TestABBundleChild(t *testing.T) {
	if os.Getenv("AB_BUNDLE_CHILD") != "1" {
		return
	}
	startBackgroundRefresh = func(*manager, *os.File) error { return nil }
	for i, arg := range os.Args {
		if arg == "--" {
			if err := run(os.Args[i+1:]); err != nil {
				t.Fatal(err)
			}
			return
		}
	}
	t.Fatal("missing child arguments")
}
func TestABAcceptanceBundleConcurrentNoOverwrite(t *testing.T) {
	cli := abBundleSetup(t)
	source := abBundleSource(t)
	root := t.TempDir()
	archive := filepath.Join(root, "winner.tar.gz")
	publish := func(args []string) {
		t.Helper()
		var workers sync.WaitGroup
		results := make(chan error, 6)
		start := make(chan struct{})
		for range 6 {
			workers.Go(func() {
				<-start
				childArgs := append([]string{"-test.run=^TestABBundleChild$", "--"}, args...)
				cmd := exec.CommandContext(t.Context(), os.Args[0], childArgs...)
				cmd.Env = append(os.Environ(), "AB_BUNDLE_CHILD=1")
				_, err := cmd.CombinedOutput()
				results <- err
			})
		}
		close(start)
		workers.Wait()
		close(results)
		successes := 0
		for err := range results {
			if err == nil {
				successes++
			}
		}
		if successes == 0 {
			t.Error("no concurrent publisher succeeded")
		}
	}
	publish(cli.args("create", source, archive))
	if err := run(cli.args("verify", archive, "")); err != nil {
		t.Fatal(err)
	}
	dest := filepath.Join(root, "winner")
	publish(cli.args("extract", archive, dest))
	if !bytes.Equal(abBundleRead(t, filepath.Join(source, "SKILL.md")), abBundleRead(t, filepath.Join(dest, cli.payloadPrefix, "SKILL.md"))) {
		t.Error("winning extraction corrupted")
	}
}
