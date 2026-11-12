import { expect, test } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { checked } from "./process";
import { executeFixedVerifier } from "./fixed-verifier";
import { createFixedFixture } from "./test-support/fixed-verifier";

const liveTest = process.env.CODEX_AB_LIVE_DOCKER === "1" ? test : test.skip;

liveTest("original fixed verifier runs offline against immutable candidate and verifier mounts", async () => {
  const image = process.env.CODEX_AB_LIVE_IMAGE ?? "codex-ab:delivery";
  const imageId = (await checked(["docker", "image", "inspect", "--format", "{{.Id}}", image])).stdout.trim();
  const verifier = `#!/bin/bash
set -eu
test ! -e /var/run/docker.sock
test ! -e /home/ubuntu/.codex/auth.json
test "$(ls /sys/class/net)" = lo
if printf tamper > /app/result.txt 2>/dev/null; then exit 125; fi
if printf tamper > /tests/test.sh 2>/dev/null; then exit 125; fi
printf private-layer-only > /logs/prior.log
if test "$(cat /app/result.txt)" = correct; then
  printf '1\\n' > /logs/verifier/reward.txt
else
  printf '0\\n' > /logs/verifier/reward.txt
  exit 1
fi
`;
  for (const [value, expected] of [["correct", "pass"], ["wrong", "fail"]] as const) {
    const fixture = await createFixedFixture(verifier, value);
    try {
      fixture.config.image = imageId;
      await writeFile(join(fixture.root, "prior.log"), "retained-before-verification\n");
      const result = await executeFixedVerifier(fixture);
      expect(result).toMatchObject({ behavioral_result: expected, evaluation_validity: "valid", cleanup_verified: true,
        methodology_comparable: false, execution_status: expected === "pass" ? "completed" : "nonzero" });
      expect(await readFile(join(fixture.candidate, "result.txt"), "utf8")).toBe(`${value}\n`);
      expect(await readFile(join(fixture.taskDirectory, "tests/test.sh"), "utf8")).toBe(verifier);
      expect(await readFile(join(fixture.root, "prior.log"), "utf8")).toBe("retained-before-verification\n");
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  }
  const early = await createFixedFixture("#!/bin/bash\nexit 0\n");
  try {
    early.config.image = imageId;
    expect(await executeFixedVerifier(early)).toMatchObject({ execution_status: "completed", behavioral_result: "unassessed",
      evaluation_validity: "invalid", reward: null, cleanup_verified: true });
  } finally { await rm(early.root, { recursive: true, force: true }); }
}, 120_000);
