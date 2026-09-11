package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

type abBundleFile struct {
	Path   string `json:"path"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
	Mode   int64  `json:"mode"`
}
type abBundleManifest struct {
	Version int            `json:"version"`
	Files   []abBundleFile `json:"files"`
}
type abTarEntry struct {
	name string
	data []byte
	mode int64
	kind byte
	link string
}

func abBundleEnv(t *testing.T) string {
	t.Helper()
	taskHome := t.TempDir()
	t.Setenv("HOME", taskHome)
	t.Setenv("XDG_CACHE_HOME", filepath.Join(taskHome, "cache"))
	t.Setenv("CODEX_HOME", filepath.Join(taskHome, "codex"))
	t.Chdir(t.TempDir())
	if err := os.WriteFile(filepath.Join(taskHome, lockName), []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	original := startBackgroundRefresh
	startBackgroundRefresh = func(*manager, *os.File) error {
		t.Error("bundle command started background refresh")
		return nil
	}
	t.Cleanup(func() { startBackgroundRefresh = original })
	return taskHome
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

func abBundleSource(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	abBundleWrite(t, filepath.Join(root, "SKILL.md"), []byte("# Example\nRead references/guide.txt\n"), 0o644)
	abBundleWrite(t, filepath.Join(root, "references/guide.txt"), []byte("guide\n"), 0o600)
	abBundleWrite(t, filepath.Join(root, "scripts/run.sh"), []byte("#!/bin/sh\necho example\n"), 0o711)
	abBundleWrite(t, filepath.Join(root, "assets/binary"), []byte{0, 255, 13, 10, 42}, 0o644)
	abBundleWrite(t, filepath.Join(root, ".hidden"), []byte("included"), 0o644)
	return root
}

func abBundleRead(t *testing.T, path string) []byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func abBundleArchive(t *testing.T, entries []abTarEntry) []byte {
	t.Helper()
	var output bytes.Buffer
	gz := gzip.NewWriter(&output)
	tw := tar.NewWriter(gz)
	for _, entry := range entries {
		header := &tar.Header{Name: entry.name, Mode: entry.mode, Typeflag: entry.kind, Linkname: entry.link}
		if entry.kind == tar.TypeReg || entry.kind == 0 {
			header.Size = int64(len(entry.data))
		}
		if err := tw.WriteHeader(header); err != nil {
			t.Fatal(err)
		}
		if header.Size > 0 {
			if _, err := tw.Write(entry.data); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	return output.Bytes()
}

func abBundleEntries(t *testing.T) []abTarEntry {
	t.Helper()
	data := []byte("# Independent fixture\n")
	digest := sha256.Sum256(data)
	manifest, err := json.Marshal(abBundleManifest{Version: 1, Files: []abBundleFile{
		{Path: "SKILL.md", Size: int64(len(data)), SHA256: hex.EncodeToString(digest[:]), Mode: 420},
	}})
	if err != nil {
		t.Fatal(err)
	}
	return []abTarEntry{
		{name: "manifest.json", data: manifest, mode: 0o644},
		{name: "files/SKILL.md", data: data, mode: 0o644},
	}
}

func abBundleMutateManifest(t *testing.T, entries []abTarEntry, change func(*abBundleManifest)) {
	t.Helper()
	var manifest abBundleManifest
	if err := json.Unmarshal(entries[0].data, &manifest); err != nil {
		t.Fatal(err)
	}
	change(&manifest)
	data, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	entries[0].data = data
}

func TestABAcceptanceBundleRoundTrip(t *testing.T) {
	taskHome := abBundleEnv(t)
	source := abBundleSource(t)
	output := filepath.Join(t.TempDir(), "skill.tar.gz")
	if err := run([]string{"bundle", "create", source, output}); err != nil {
		t.Fatal(err)
	}
	if err := run([]string{"bundle", "verify", output}); err != nil {
		t.Fatal(err)
	}
	destination := filepath.Join(t.TempDir(), "restored")
	if err := run([]string{"bundle", "extract", output, destination}); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"SKILL.md", "references/guide.txt", "scripts/run.sh", "assets/binary", ".hidden"} {
		if !bytes.Equal(abBundleRead(t, filepath.Join(source, path)), abBundleRead(t, filepath.Join(destination, path))) {
			t.Errorf("content differs for %s", path)
		}
		stat, err := os.Stat(filepath.Join(destination, path))
		if err != nil {
			t.Fatal(err)
		}
		want := os.FileMode(0o644)
		if path == "scripts/run.sh" {
			want = 0o755
		}
		if stat.Mode().Perm() != want {
			t.Errorf("%s mode %o, want %o", path, stat.Mode().Perm(), want)
		}
	}
	entries, err := os.ReadDir(taskHome)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Name() != lockName || string(abBundleRead(t, filepath.Join(taskHome, lockName))) != "{}\n" {
		t.Error("bundle operations modified home/selection metadata")
	}
}

func TestABAcceptanceBundleDeterminism(t *testing.T) {
	abBundleEnv(t)
	first := abBundleSource(t)
	second := abBundleSource(t)
	if err := filepath.WalkDir(second, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if !entry.IsDir() {
			return os.Chtimes(path, time.Unix(1234, 0), time.Unix(5678, 0))
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	a, b := filepath.Join(t.TempDir(), "a.gz"), filepath.Join(t.TempDir(), "b.gz")
	for _, item := range [][2]string{{first, a}, {second, b}} {
		if err := run([]string{"bundle", "create", item[0], item[1]}); err != nil {
			t.Fatal(err)
		}
	}
	if !bytes.Equal(abBundleRead(t, a), abBundleRead(t, b)) {
		t.Error("equivalent source trees produced different archive bytes")
	}
	gz, err := gzip.NewReader(bytes.NewReader(abBundleRead(t, a)))
	if err != nil {
		t.Fatal(err)
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	payload := map[string][]byte{}
	var manifest abBundleManifest
	for {
		header, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		if header.Typeflag != tar.TypeReg {
			t.Fatalf("create emitted nonregular entry %s", header.Name)
		}
		data, err := io.ReadAll(io.LimitReader(tr, 1<<20))
		if err != nil {
			t.Fatal(err)
		}
		if header.Name == "manifest.json" {
			if err := json.Unmarshal(data, &manifest); err != nil {
				t.Fatal(err)
			}
		} else {
			payload[strings.TrimPrefix(header.Name, "files/")] = data
		}
	}
	if manifest.Version != 1 || len(manifest.Files) != 5 || len(payload) != 5 {
		t.Fatalf("incorrect manifest/payload cardinality: %+v, %d", manifest, len(payload))
	}
	paths := make([]string, 0, len(manifest.Files))
	for _, file := range manifest.Files {
		paths = append(paths, file.Path)
		data, ok := payload[file.Path]
		sum := sha256.Sum256(data)
		if !ok || int64(len(data)) != file.Size || hex.EncodeToString(sum[:]) != file.SHA256 {
			t.Errorf("incorrect manifest record %+v", file)
		}
	}
	if !slices.IsSorted(paths) {
		t.Error("manifest paths are not sorted")
	}
}

func TestABAcceptanceBundleHostileArchives(t *testing.T) {
	abBundleEnv(t)
	cases := map[string]func([]abTarEntry) []abTarEntry{
		"missing-payload": func(e []abTarEntry) []abTarEntry { return e[:1] },
		"extra-payload": func(e []abTarEntry) []abTarEntry {
			return append(e, abTarEntry{name: "files/extra", data: []byte("extra"), mode: 0o644})
		},
		"duplicate-payload":  func(e []abTarEntry) []abTarEntry { return append(e, e[1]) },
		"duplicate-manifest": func(e []abTarEntry) []abTarEntry { return append(e, e[0]) },
		"digest":             func(e []abTarEntry) []abTarEntry { e[1].data = []byte("tampered"); return e },
		"traversal":          func(e []abTarEntry) []abTarEntry { e[1].name = "../escape"; return e },
		"absolute":           func(e []abTarEntry) []abTarEntry { e[1].name = "/tmp/escape"; return e },
		"symlink":            func(e []abTarEntry) []abTarEntry { e[1].kind = tar.TypeSymlink; e[1].link = "../../escape"; return e },
		"hardlink":           func(e []abTarEntry) []abTarEntry { e[1].kind = tar.TypeLink; e[1].link = "manifest.json"; return e },
		"version": func(e []abTarEntry) []abTarEntry {
			abBundleMutateManifest(t, e, func(m *abBundleManifest) { m.Version = 2 })
			return e
		},
		"mode": func(e []abTarEntry) []abTarEntry {
			abBundleMutateManifest(t, e, func(m *abBundleManifest) { m.Files[0].Mode = 0o777 })
			return e
		},
		"negative-size": func(e []abTarEntry) []abTarEntry {
			abBundleMutateManifest(t, e, func(m *abBundleManifest) { m.Files[0].Size = -1 })
			return e
		},
		"manifest-path": func(e []abTarEntry) []abTarEntry {
			abBundleMutateManifest(t, e, func(m *abBundleManifest) { m.Files[0].Path = "a/../SKILL.md" })
			return e
		},
		"backslash": func(e []abTarEntry) []abTarEntry {
			abBundleMutateManifest(t, e, func(m *abBundleManifest) { m.Files[0].Path = `a\SKILL.md` })
			return e
		},
		"duplicate-record": func(e []abTarEntry) []abTarEntry {
			abBundleMutateManifest(t, e, func(m *abBundleManifest) { m.Files = append(m.Files, m.Files[0]) })
			return e
		},
		"oversized-claim": func(e []abTarEntry) []abTarEntry {
			abBundleMutateManifest(t, e, func(m *abBundleManifest) { m.Files[0].Size = (16 << 20) + 1 })
			return e
		},
		"oversized-manifest": func(e []abTarEntry) []abTarEntry {
			e[0].data = append(e[0].data, bytes.Repeat([]byte(" "), 1<<20)...)
			return e
		},
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			container := t.TempDir()
			archive := filepath.Join(container, "bad.gz")
			abBundleWrite(t, archive, abBundleArchive(t, mutate(abBundleEntries(t))), 0o644)
			if err := run([]string{"bundle", "verify", archive}); err == nil {
				t.Error("verify accepted invalid archive")
			}
			if err := run([]string{"bundle", "extract", archive, filepath.Join(container, "output")}); err == nil {
				t.Error("extract accepted invalid archive")
			}
			entries, err := os.ReadDir(container)
			if err != nil {
				t.Fatal(err)
			}
			if len(entries) != 1 || entries[0].Name() != "bad.gz" {
				t.Errorf("failed extraction left output or temporary state: %v", entries)
			}
		})
	}
}

func TestABAcceptanceBundleIndependentArchiveAndTrailer(t *testing.T) {
	abBundleEnv(t)
	container := t.TempDir()
	archive := filepath.Join(container, "external.gz")
	valid := abBundleArchive(t, abBundleEntries(t))
	abBundleWrite(t, archive, valid, 0o644)
	if err := run([]string{"bundle", "verify", archive}); err != nil {
		t.Fatalf("independently constructed valid archive: %v", err)
	}
	if err := run([]string{"bundle", "extract", archive, filepath.Join(container, "valid")}); err != nil {
		t.Fatal(err)
	}
	if string(abBundleRead(t, filepath.Join(container, "valid/SKILL.md"))) != "# Independent fixture\n" {
		t.Error("independent archive content differs")
	}
	corrupt := bytes.Clone(valid)
	corrupt[len(corrupt)-8] ^= 0xff
	for _, data := range [][]byte{corrupt, valid[:len(valid)-5]} {
		abBundleWrite(t, archive, data, 0o644)
		if err := run([]string{"bundle", "verify", archive}); err == nil {
			t.Error("verify ignored corrupt or truncated gzip trailer")
		}
		if err := run([]string{"bundle", "extract", archive, filepath.Join(container, "bad")}); err == nil {
			t.Error("extract ignored corrupt or truncated gzip trailer")
		}
		if _, err := os.Lstat(filepath.Join(container, "bad")); !os.IsNotExist(err) {
			t.Error("failed trailer validation published destination")
		}
	}
}

func TestABAcceptanceBundleNoClobberAndSourceSafety(t *testing.T) {
	abBundleEnv(t)
	source := abBundleSource(t)
	container := t.TempDir()
	archive := filepath.Join(container, "existing.gz")
	abBundleWrite(t, archive, []byte("preserve"), 0o644)
	if err := run([]string{"bundle", "create", source, archive}); err == nil {
		t.Error("create overwrote existing destination")
	}
	if string(abBundleRead(t, archive)) != "preserve" {
		t.Error("create destroyed existing output")
	}
	inside := filepath.Join(source, "self.gz")
	if err := run([]string{"bundle", "create", source, inside}); err == nil {
		t.Error("create allowed output inside source")
	}
	if _, err := os.Lstat(inside); !os.IsNotExist(err) {
		t.Error("rejected create left output in source")
	}
	if err := os.Symlink("SKILL.md", filepath.Join(source, "alias")); err != nil {
		t.Fatal(err)
	}
	if err := run([]string{"bundle", "create", source, filepath.Join(container, "symlink.gz")}); err == nil {
		t.Error("create accepted source symlink")
	}
	validArchive := filepath.Join(container, "valid.gz")
	abBundleWrite(t, validArchive, abBundleArchive(t, abBundleEntries(t)), 0o644)
	dest := filepath.Join(container, "existing")
	if err := os.Mkdir(dest, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := run([]string{"bundle", "extract", validArchive, dest}); err == nil {
		t.Error("extract replaced existing empty directory")
	}
	entries, err := os.ReadDir(dest)
	if err != nil || len(entries) != 0 {
		t.Error("extract changed existing directory")
	}
	for _, args := range [][]string{{"bundle"}, {"bundle", "create"}, {"bundle", "verify"}, {"bundle", "extract"}, {"bundle", "verify", validArchive, "extra"}} {
		if err := run(args); err == nil {
			t.Errorf("invalid arguments accepted: %v", args)
		}
	}
}

func TestABAcceptanceBundleConcurrentPublication(t *testing.T) {
	abBundleEnv(t)
	source := abBundleSource(t)
	container := t.TempDir()
	archive := filepath.Join(container, "winner.gz")
	errs := make(chan error, 6)
	start := make(chan struct{})
	var workers sync.WaitGroup
	for range 6 {
		workers.Go(func() {
			<-start
			errs <- run([]string{"bundle", "create", source, archive})
		})
	}
	close(start)
	workers.Wait()
	close(errs)
	successes := 0
	for err := range errs {
		if err == nil {
			successes++
		}
	}
	if successes != 1 {
		t.Fatalf("%d publishers succeeded, want exactly one", successes)
	}
	if err := run([]string{"bundle", "verify", archive}); err != nil {
		t.Fatal(err)
	}
	destination := filepath.Join(container, "winner")
	errs = make(chan error, 6)
	start = make(chan struct{})
	for range 6 {
		workers.Go(func() {
			<-start
			errs <- run([]string{"bundle", "extract", archive, destination})
		})
	}
	close(start)
	workers.Wait()
	close(errs)
	successes = 0
	for err := range errs {
		if err == nil {
			successes++
		}
	}
	if successes != 1 {
		t.Fatalf("%d extractors succeeded, want exactly one", successes)
	}
	entries, err := os.ReadDir(container)
	if err != nil || len(entries) != 2 {
		t.Errorf("publishers leaked temporary state: %v, %v", entries, err)
	}
}

