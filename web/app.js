"use strict";
const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
const obj = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const words = (value) => String(value).replaceAll("_", " ").replaceAll("-", " ");
const metric = (value, digits = 0) => typeof value === "number" && Number.isFinite(value) ? value.toLocaleString(undefined, { maximumFractionDigits: digits }) : "Unknown";
const duration = (ms) => typeof ms === "number" && Number.isFinite(ms) ? metric(ms / 1000, 1) + " s" : "Unknown";
let config, workflow = "pair", selected, snapshot, activeId, busy = false, actionEntry, reportSignature, stateSignature;
let artifactItems = [];
let listSignature, artifactSignature, childSignature, liveKeys;
let eventStream, latestSnapshot;
const MEKUGI_TOGGLES = [
  ["shell-guard", "Guard remote VCS writes and sudo commands"],
  ["deduplicate-output", "Deduplicate output and attachments"],
  ["child-reply-summary", "Show child-authored reply summaries"],
];
const MEKUGI_VALUES = ["ansi-faint", "timeout", "stream-idle-timeout"];
const ATTEMPT_STATUS = { started: "Running", stopped: "Finished", failed: "Failed" };
const TONES = { stopped: "positive", complete: "positive", failed: "negative", canceled: "negative" };
const QUALITY_ASPECT_KEYS = ["simplicity", "performance", "approach"];
function executionStatus(attempt, result) {
  attempt = obj(attempt); result = obj(result);
  if (!attempt.status) return ["Not started", ""];
  const facts = [result.timed_out ? "timed out" : result.canceled ? "canceled" : typeof result.exit_code === "number" ? "exit " + result.exit_code : "",
    typeof result.agent_elapsed_ms === "number" ? duration(result.agent_elapsed_ms) : ""].filter(Boolean);
  return [[ATTEMPT_STATUS[attempt.status] || words(attempt.status), ...facts].join(" · "), TONES[attempt.status] || ""];
}
function setupLabels(data) {
  if (!data.state && !data.report) return {};
  return { stock: "Setup unavailable", current: "Setup unavailable", ...obj(data.arm_labels), ...obj(obj(data.report).arm_labels) };
}
function displayName(value, names) {
  const text = String(value ?? "");
  return Object.hasOwn(names, text) ? names[text] : text.replace(/\bcandidate[-_ ](\d+)\b/gi, (_, number) => names["candidate-" + number] || "Unmapped setup");
}
function assessmentNames(value, names) {
  const order = obj(value).presentation;
  return Array.isArray(order) ? { ...names, ...Object.fromEntries(order.map((arm, index) => ["candidate-" + (index + 1), names[arm] || "Unmapped setup"])) } : names;
}
function semanticNames(key, passes, names) {
  const pass = (Array.isArray(passes) ? passes : []).find((item) => key === `pass-${item.pass}` || key === `pass-${item.pass}-existing`);
  return assessmentNames(pass, names);
}
function field(label, name, value = "", type = "text", hint = "", prefix = "f") {
  const id = prefix + "-" + name;
  return '<div class="field"><label for="' + id + '">' + esc(label) + '</label><input id="' + id + '" name="' + esc(name) + '" type="' + type + '" value="' + esc(value) + '" spellcheck="false">' + (hint ? '<p class="hint">' + esc(hint) + '</p>' : "") + "</div>";
}
function sourceHint(task) {
  return task.repository ? "Local Git checkout. A missing checkout is cloned from " + task.repository + " during preparation." : "Local Git checkout.";
}
function select(label, name, options, value = "", hint = "", prefix = "f") {
  const id = prefix + "-" + name;
  return '<div class="field"><label for="' + id + '">' + esc(label) + '</label><select id="' + id + '" name="' + esc(name) + '">' + options.map(([key, text]) => '<option value="' + esc(key) + '"' + (key === value ? " selected" : "") + ">" + esc(text) + "</option>").join("") + "</select>" + (hint ? '<p class="hint">' + esc(hint) + '</p>' : "") + "</div>";
}
function check(label, name, prefix = "f", checked = false) {
  return '<label class="check"><input id="' + prefix + "-" + name + '" type="checkbox" name="' + name + '"' + (checked ? " checked" : "") + '>' + esc(label) + "</label>";
}
function formOptions(form) {
  const options = {};
  for (const [key, value] of new FormData(form)) if (String(value).trim()) options[key] = value;
  for (const checkbox of form.querySelectorAll('input[type="checkbox"][name]')) {
    if (checkbox.checked && !checkbox.disabled) options[checkbox.name] = true;
    else delete options[checkbox.name];
  }
  return options;
}
async function api(path, body) {
  const response = await fetch("/api/" + path, body === undefined ? { cache: "no-store" } : { method: "POST", headers: { "Content-Type": "application/json", "x-codex-ab-token": config.token }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Local service request failed");
  return data;
}
function showNotice(id, text, error = false) {
  const element = $(id);
  element.hidden = false;
  element.textContent = text;
  element.classList.toggle("error", error);
}
function sharedFields() {
  const defaults = config.defaults;
  return field("Current setup home", "current-home", defaults["current-home"], "text", "Guidance and tool setup to snapshot.")
    + field("Container image", "image", defaults.image)
    + field("Codex executable", "codex-bin", defaults["codex-bin"])
    + field("Bun executable (optional)", "bun-bin")
    + field("Docker executable", "docker-bin", defaults["docker-bin"])
    + field("Output parent (optional)", "output-parent", "", "text", "Use a directory outside the source checkout.")
    + field("CPU limit per arm", "cpus", "2", "number")
    + field("Memory limit per arm", "memory", "4g")
    + field("Timeout in seconds (optional)", "timeout", "", "number", "Uses the selected task default.");
}
let customArmIndex = 0;
function customArmRows() {
  return [...$("custom-arms").querySelectorAll(".custom-arm")].map(row => ({ launcher: row.querySelector("select").value, setup_commit: row.querySelectorAll("select")[1].value === "stock" ? "stock" : row.querySelector("input").value }));
}
function addCustomArm(launcher = "mekugi", revision = "HEAD") {
  const index = ++customArmIndex;
  const row = document.createElement("div");
  row.className = "custom-arm grid";
  row.innerHTML = '<p class="imported-setup" hidden></p>' + select("Launcher " + index, "arm-launcher-" + index, [["codex", "Codex"], ["mekugi", "Mekugi"]], launcher)
    + select("Setup " + index, "arm-setup-" + index, [["stock", "Stock"], ["revision", "Committed SHA"]], revision === "stock" ? "stock" : "revision")
    + field("Setup revision " + index, "arm-revision-" + index, revision === "stock" ? "HEAD" : revision)
    + '<div class="evaluation-baseline" hidden>' + select("Historical evaluation baseline", "arm-evaluation-" + index, []) + '</div>'
    + '<button type="button">Remove setup</button>';
  const setup = row.querySelectorAll("select")[1];
  const updateSetup = () => { row.querySelector("input").disabled = setup.value === "stock"; row.querySelector("input").parentElement.hidden = setup.value === "stock"; };
  setup.addEventListener("input", updateSetup);
  setup.addEventListener("change", updateSetup);
  updateSetup();
  for (const input of row.querySelectorAll("input,select")) { input.removeAttribute("name"); input.addEventListener("input", updateCombination); input.addEventListener("change", updateCombination); }
  row.querySelector("button").addEventListener("click", () => {
    const removed = [...$("custom-arms").children].indexOf(row);
    for (const input of $("custom-arms").querySelectorAll(".evaluation-baseline select")) {
      const slot = input.value === "stock" ? 0 : input.value === "current" ? 1 : Number(input.value.slice(4)) - 1;
      if (slot === removed) input.value = "";
      else if (slot > removed) input.value = slot === 1 ? "stock" : slot === 2 ? "current" : "arm-" + slot;
    }
    for (const imported of [...$("imported-arms").children]) {
      const target = imported.querySelector("select");
      const slot = target.selectedIndex;
      if (slot === removed) imported.remove();
      else if (slot > removed) target.selectedIndex = slot - 1;
    }
    row.remove(); updateCombination();
  });
  $("custom-arms").append(row);
}
function importedArmRows() {
  return [...$("imported-arms").children].map(row => ({ target_arm: row.querySelector("select").value,
    run_dir: row.querySelectorAll("input")[0].value.trim(), arm: row.querySelectorAll("input")[1].value.trim() }));
}
function addImportedArm(value = {}, label = "") {
  const index = ++customArmIndex;
  const row = document.createElement("div");
  row.className = "custom-arm grid";
  row.dataset.sourceLabel = label;
  row.innerHTML = select("Comparison slot", "import-target-" + index, [["stock", "First setup"], ["current", "Second setup"]])
    + field("Previous run directory", "import-directory-" + index, "", "text", "Absolute retained run directory, not its bundle directory.")
    + field("Previous arm key", "import-arm-" + index, "current", "text", "Use stock, current, arm-3, etc. from the previous run.")
    + '<button type="button">Remove import</button>';
  for (const input of row.querySelectorAll("input,select")) { input.removeAttribute("name"); input.addEventListener("input", updateCombination); }
  for (const input of row.querySelectorAll("input")) input.addEventListener("input", () => {
    row.dataset.sourceLabel = "";
    row.querySelectorAll("input")[1].closest(".field").querySelector(".hint").textContent = "Use stock, current, arm-3, etc. from the previous run.";
    updateCombination();
  });
  row.querySelector("button").addEventListener("click", () => { row.remove(); updateCombination(); });
  $("imported-arms").append(row);
  updateCombination();
  row.querySelector("select").value = value.target_arm || "stock";
  row.querySelectorAll("input")[0].value = value.run_dir || "";
  row.querySelectorAll("input")[1].value = value.arm || "current";
  if (label) row.querySelectorAll("input")[1].closest(".field").querySelector(".hint").textContent = label;
  updateCombination();
}
async function compareAgainstHead(directory, statusId, button) {
  button.disabled = true;
  showNotice(statusId, "Loading previous arms and matching run controls…");
  try {
    const draft = await api("comparison-draft", { directory });
    workflow = "pair"; drawLaunch();
    const options = draft.options;
    for (const [name, value] of Object.entries(options)) if ($("f-" + name)) $("f-" + name).value = value;
    $("custom-arms").replaceChildren();
    for (const arm of JSON.parse(options.arms)) addCustomArm(arm.launcher, arm.setup_commit);
    for (const flag of JSON.parse(options["mekugi-flags"])) {
      const [name, value] = flag.slice(2).split("=");
      const input = $("f-mekugi-" + name);
      if (input?.type === "checkbox") input.checked = value !== "false";
      else if (input) input.value = value;
    }
    const imports = JSON.parse(options["import-arms"]);
    for (const imported of imports) addImportedArm(imported, draft.labels[imported.arm]);
    for (const input of $("custom-arms").querySelectorAll(".evaluation-baseline select")) input.value = imports.at(-1).target_arm;
    updateCombination();
    selected = undefined; $("launch-view").hidden = false; $("watch-view").hidden = true;
    history.replaceState(null, "", "/"); connectEvents();
    showNotice("input-status", "Previous arms loaded. Only the final HEAD setup executes. Historical grades and scores are reused by default; fresh candidates adapt historical tests to their implementation. HEAD is the setup configuration repository revision. Review evaluation settings and confirm inference to start.");
    $("f-preset").focus();
  } catch (error) { showNotice(statusId, error.message, true); }
  finally { button.disabled = false; }
}
function drawLaunch() {
  const defaults = config.defaults;
  customArmIndex = 0;
  $("input-status").hidden = true;
  $("prepare-only").checked = false;
  $("paid-consent").checked = false;
  for (const button of document.querySelectorAll("[data-workflow]")) button.setAttribute("aria-pressed", String(button.dataset.workflow === workflow));
  let fields;
  if (workflow === "pair") {
    const task = config.tasks.find((item) => item.id === defaults.task);
    fields = '<section class="form-section"><h2>Reuse a completed run</h2>'
      + field("Previous run directory", "reuse-directory", "", "text", "Load its arms and matching controls, then execute one fresh setup at HEAD.")
      + '<button id="reuse-run" type="button">Compare against HEAD</button><p id="reuse-status" role="status" hidden></p></section><div class="grid">'
      + select("Comparison", "preset", config.comparisons.map((item) => [item.id, item.title]), defaults.preset)
      + select("Task", "task", config.tasks.map((item) => [item.id, item.title]), defaults.task)
      + '</div><div id="setup-commit-fields" class="grid" hidden>'
      + field("Setup commit A", "setup-a-commit", "", "text", "Baseline revision in the setup configuration repository.")
      + field("Setup commit B", "setup-b-commit", "", "text", "Treatment revision; live tracked edits are excluded.")
      + '</div><section id="custom-composition" hidden><h2>Compared setups</h2><p class="hint">Choose at least two setups. For each, choose Codex or Mekugi with Stock guidance or a committed setup revision. Shared controls apply to every setup.</p><div id="custom-arms"></div><button id="add-custom-arm" type="button">Add setup</button></section><div id="comparison-preview" class="comparison-preview"></div><p id="comparison-description" class="description"></p><section class="form-section" aria-labelledby="run-settings-title"><h2 id="run-settings-title">Run configuration</h2><div class="grid">'
      + '<div class="source-field">' + field("Source checkout", "source", task.source, "text", sourceHint(task)) + '</div>'
      + select("Model", "model", [["gpt-6-astra", "GPT-6 Astra"], ["gpt-6.1-sol", "GPT-6.1 Sol"]], defaults.model)
      + select("Reasoning effort", "reasoning-effort", [["", "Task default"], ...config.reasoningEfforts.map((value) => [value, words(value)])], "", "NVM and portable packs: medium. Long-horizon tasks: xhigh. Grok: high.")
      + '<div>' + check("Parallel work", "parallel-work") + '<p class="hint">Ask both agents to delegate independent work. Unchecked keeps existing behavior.</p></div>'
      + field("Fresh pair count", "count", "1", "number", "One is a single pair. Two or more create a trial set.")
      + select("Trial arm order", "order", [["concurrent", "Concurrent"], ["alternating", "Alternating first arm"]], "concurrent")
      + '<div id="compaction-limit-field">' + field("Shared compaction token limit", "auto-compact-limit", task.compactLimit ?? "", "number", "Both arms compact at this context size. Optional for minimal Codex versus Mekugi; a blank field uses the task default.") + "</div></div></section>"
      + '<details class="advanced"><summary>Runtime and resource settings</summary><div class="grid">' + sharedFields()
      + field("Codex authentication file", "auth-file", defaults["auth-file"], "text", "Local path only. Never paste credential contents.")
      + field("Grok authentication file", "grok-auth-file", defaults["grok-auth-file"])
      + '</div></details><details class="advanced"><summary>Mekugi and comparison settings</summary><div class="grid">'
      + select("Current-setup launcher", "current-launcher", [["codex", "Direct Codex"], ["mekugi", "Mekugi"]], "codex", "For setup-commit comparisons this launcher applies to both arms.")
      + field("Mekugi source", "mekugi-source", defaults["mekugi-source"])
      + field("Mekugi executable", "mekugi-bin", defaults["mekugi-bin"])
      + field("Captured Mekugi build (optional)", "mekugi-build", "", "text", "Owns its executable and source when supplied.")
      + '<fieldset class="mekugi-settings"><legend>Mekugi behavior</legend><p class="hint">Applies to this run only. Export diagnostics are enabled automatically.</p><div class="grid"><div>'
      + MEKUGI_TOGGLES.map(([name, label]) => check(label, "mekugi-" + name, "f", true)).join("")
      + '<p id="deduplication-owned" class="hint" hidden>The comparison sets deduplication off for A and on for B.</p></div>'
      + select("Faint text", "mekugi-ansi-faint", [["auto", "Auto"], ["on", "On"], ["off", "Off"]], "auto")
      + field("Response-start timeout", "mekugi-timeout", "", "text", "Mekugi default: 10m. Use a duration such as 30s or 2m.")
      + field("Stream idle timeout", "mekugi-stream-idle-timeout", "", "text", "Mekugi default: 4m. Use a duration such as 30s or 2m.")
      + '</div></fieldset>'
      + field("Grok executable", "grok-bin", defaults["grok-bin"])
      + field("Reviewer treatment (optional)", "review-treatment", "", "text", "Use an existing reviewer overlay path.")
      + '</div>' + check("Use protected Mekugi runtime", "protect-mekugi") + '</details>'
      + '<section class="form-section"><h2>Compare with previous runs</h2><p class="hint">Import completed arms without executing them again. Leave at least one fresh setup with matching task and execution controls. Use repeat count 1.</p><div id="imported-arms"></div><button id="add-imported-arm" type="button">Import previous arm</button>'
      + '<div id="evaluation-settings" hidden>' + select("Evaluation", "evaluation-mode", [["reuse", "Reuse historical evaluation"], ["fresh", "Fresh evaluation of all candidates"]], "reuse", "Reuse keeps imported grades, scores and assessments unchanged. The judge adapts historical tests to each fresh implementation while testing the same behaviors. Fresh evaluation regrades and rescores every patch.")
      + '<div id="paired-evaluation-baselines"></div></div></section>'
      + '<details class="advanced" id="custom-task-fields"><summary>Custom task contract</summary><p class="hint">A portable pack owns its prompt, criteria, profile and commits. Otherwise supply all four standalone controls.</p><div class="grid">'
      + field("Portable task-pack manifest", "task-pack")
      + field("Task prompt file", "task-file")
      + field("Criteria JSON file", "criteria")
      + field("Base commit", "base")
      + field("Forbidden solution commit", "forbidden")
      + select("Task profile", "profile", [["", "Default"], ["task", "Portable task"], ["mekugi", "Mekugi"], ["skills-mgr-bundle", "Skills manager bundle"], ["godoxy-icons", "GoDoxy icons"]])
      + "</div></details>";
  } else if (workflow === "suite") {
    fields = '<p class="description">Run a pinned set of tasks with fresh repeated pairs. Suites compare minimal and current setup. Task contracts own the model and evaluation controls.</p><div class="grid">'
      + field("Suite manifest", "suite", "tasks/diverse-suite.json", "text", "The pinned diverse suite contains Gin, Flask, Express and NVM.")
      + field("Source-mapping JSON file", "sources-file", "", "text", "Maps each suite task to its local checkout.")
      + field("Fresh pairs per task", "count", "2", "number")
      + select("Arm order", "order", [["alternating", "Alternating first arm"], ["concurrent", "Concurrent"]], "alternating")
      + '</div><details class="advanced"><summary>Runtime and resource settings</summary><div class="grid">' + sharedFields()
      + field("Codex authentication file for execution", "suite-auth-file", defaults["auth-file"])
      + field("Reviewer treatment (optional)", "review-treatment")
      + "</div></details>";
  } else {
    fields = '<p class="description">Freeze a Mekugi source snapshot, compile it in an immutable builder image, and retain executable identity and build logs. This operation makes no model requests.</p><div class="grid">'
      + field("Mekugi source checkout", "source", defaults["mekugi-source"])
      + field("Builder image", "image", defaults.image, "text", "An existing image with Go and Python 3.")
      + field("Output parent (optional)", "output-parent")
      + field("Docker executable", "docker-bin", defaults["docker-bin"]) + "</div>";
  }
  $("launch-fields").innerHTML = fields;
  if (workflow === "pair") {
    $("f-task").addEventListener("change", () => {
      const task = config.tasks.find((item) => item.id === $("f-task").value);
      $("f-source").value = task.source;
      $("f-source").closest(".field").querySelector(".hint").textContent = sourceHint(task);
      $("f-auto-compact-limit").value = task.compactLimit ?? "";
      if (task.preset) {
        $("f-preset").value = task.preset;
      }
      updateCombination();
    });
    addCustomArm("codex", "stock"); addCustomArm("mekugi");
    $("add-custom-arm").addEventListener("click", () => { addCustomArm(); updateCombination(); });
    $("add-imported-arm").addEventListener("click", () => addImportedArm());
    $("reuse-run").addEventListener("click", (event) => compareAgainstHead($("f-reuse-directory").value, "reuse-status", event.currentTarget));
    $("f-reuse-directory").removeAttribute("name");
    for (const id of ["f-preset", "f-current-launcher", "f-mekugi-build", "f-task-pack", "f-evaluation-mode"]) {
      $(id).addEventListener("input", updateCombination);
      $(id).addEventListener("change", updateCombination);
    }
    updateCombination();
  }
  $("prepare-only").parentElement.hidden = workflow === "build";
  updateConsent();
}
function setEnabled(id, enabled) { if ($(id)) $(id).disabled = !enabled; }
function updateCombination() {
  const comparison = config.comparisons.find((item) => item.id === $("f-preset").value);
  const grok = comparison.id === "codex-mekugi-grok";
  const composition = comparison.id === "custom";
  const configuredArms = customArmRows();
  const slotCount = composition ? configuredArms.length : 2;
  for (const row of $("imported-arms").children) {
    const select = row.querySelector("select"), selected = select.value;
    const keys = Array.from({ length: slotCount }, (_, i) => i === 0 ? "stock" : i === 1 ? "current" : "arm-" + (i + 1));
    select.innerHTML = keys.map((key, i) => '<option value="' + key + '">' + esc("Setup " + (i + 1) + " (" + key + ")") + '</option>').join("");
    select.value = keys.includes(selected) ? selected : "stock";
  }
  for (const button of $("custom-arms").querySelectorAll("button")) button.disabled = configuredArms.length <= 2;
  const imports = importedArmRows();
  $("evaluation-settings").hidden = !imports.length;
  $("f-evaluation-mode").disabled = !imports.length;
  const reuse = imports.length && $("f-evaluation-mode").value === "reuse";
  const baselineOptions = imports.map((item, index) => [item.target_arm,
    ($("imported-arms").children[index].dataset.sourceLabel || "Imported " + item.arm) + " · " + item.run_dir.split("/").at(-1)]);
  const updateBaseline = (input) => {
    const previous = input.value;
    input.innerHTML = baselineOptions.map(([key, label]) => '<option value="' + esc(key) + '">' + esc(label) + '</option>').join("");
    input.value = imports.some(item => item.target_arm === previous) ? previous : imports.at(-1)?.target_arm || "";
    input.disabled = !reuse;
  };
  for (const [index, row] of [...$("custom-arms").children].entries()) {
    for (const [i, label] of [...row.querySelectorAll(":scope > .field label")].entries()) label.textContent = ["Launcher ", "Setup ", "Setup revision "][i] + (index + 1);
    const imported = [...$("imported-arms").children].find(source => source.querySelector("select").selectedIndex === index);
    const label = row.querySelector(".imported-setup");
    label.hidden = !imported;
    label.textContent = imported ? "Imported: " + (imported.dataset.sourceLabel || imported.querySelectorAll("input")[1].value) : "";
    for (const field of row.querySelectorAll(".field")) field.hidden = Boolean(imported);
    if (!imported) row.querySelector("input").parentElement.hidden = row.querySelectorAll("select")[1].value === "stock";
    const baseline = row.querySelector(".evaluation-baseline");
    baseline.hidden = Boolean(imported) || !reuse;
    baseline.querySelector(".field").hidden = false;
    updateBaseline(baseline.querySelector("select"));
  }
  const paired = $("paired-evaluation-baselines");
  paired.hidden = composition || !reuse;
  const previousBaselines = Object.fromEntries([...paired.querySelectorAll("select")].map(input => [input.dataset.arm, input.value]));
  paired.innerHTML = composition || !reuse ? "" : ["stock", "current"].filter(arm => !imports.some(item => item.target_arm === arm)).map(arm => select("Evaluation baseline for " + arm, "baseline-" + arm, baselineOptions, previousBaselines[arm] || imports.at(-1).target_arm)).join("");
  for (const input of paired.querySelectorAll("select")) { input.dataset.arm = input.name.slice("baseline-".length); input.removeAttribute("name"); }
  $("custom-composition").hidden = !composition;
  const mekugi = composition ? configuredArms.some(arm => arm.launcher === "mekugi") : !["stock-current", "setup-commits"].includes(comparison.id) || $("f-current-launcher").value === "mekugi";
  const titleB = comparison.id === "stock-current" && mekugi ? "Mekugi · current setup" : comparison.b;
  $("comparison-preview").innerHTML = '<article><h2>' + esc(comparison.a) + '</h2><p>Fresh isolated workspace</p></article><article><h2>' + esc(titleB) + '</h2><p>Same task and resource limits</p></article>';
  if (composition) $("comparison-preview").innerHTML = configuredArms.map(arm => "<article><h2>" + esc((arm.launcher === "mekugi" ? "Mekugi" : "Codex") + " + " + (arm.setup_commit === "stock" ? "Stock" : arm.setup_commit)) + "</h2><p>Fresh isolated workspace</p></article>").join("");
  for (const imported of importedArmRows()) {
    const index = imported.target_arm === "stock" ? 0 : imported.target_arm === "current" ? 1 : Number(imported.target_arm.slice(4)) - 1;
    const preview = $("comparison-preview").children[index];
    const sourceRow = [...$("imported-arms").children].find(row => row.querySelector("select").value === imported.target_arm);
    if (preview) preview.innerHTML = '<h2>Imported ' + esc(sourceRow?.dataset.sourceLabel || imported.arm || "arm") + '</h2><p>' + esc(imported.run_dir || "Choose a previous run") + '</p>';
  }
  $("comparison-description").textContent = comparison.description + (grok ? " The fixed model is Grok 4.7." : "");
  setEnabled("f-model", !grok);
  setEnabled("f-current-launcher", ["stock-current", "setup-commits"].includes(comparison.id));
  $("setup-commit-fields").hidden = comparison.id !== "setup-commits";
  for (const name of ["setup-a-commit", "setup-b-commit"]) setEnabled("f-" + name, comparison.id === "setup-commits");
  const sharedLimit = comparison.id === "stock-mekugi";
  setEnabled("f-auto-compact-limit", sharedLimit);
  $("compaction-limit-field").hidden = !sharedLimit;
  const build = $("f-mekugi-build").value.trim();
  for (const id of ["f-mekugi-source", "f-mekugi-bin"]) setEnabled(id, mekugi && !build);
  setEnabled("f-mekugi-build", mekugi);
  for (const name of [...MEKUGI_TOGGLES.map(([name]) => name), ...MEKUGI_VALUES]) setEnabled("f-mekugi-" + name, mekugi);
  setEnabled("f-mekugi-deduplicate-output", mekugi && comparison.id !== "duplicate-output");
  $("deduplication-owned").hidden = comparison.id !== "duplicate-output";
  for (const id of ["f-grok-bin", "f-grok-auth-file"]) setEnabled(id, grok);
  setEnabled("f-protect-mekugi", mekugi && ["stock-current", "same-setup"].includes(comparison.id));
  setEnabled("f-review-treatment", !["custom", "stock-mekugi", "codex-mekugi-grok", "setup-commits"].includes(comparison.id));
  const custom = $("f-task").value === "custom";
  $("custom-task-fields").hidden = !custom;
  for (const input of $("custom-task-fields").querySelectorAll("input,select")) input.disabled = !custom;
  if (custom && $("f-task-pack").value.trim()) for (const name of ["base", "forbidden", "task-file", "criteria", "profile"]) setEnabled("f-" + name, false);
  $("input-status").hidden = true;
}
function updateConsent() {
  const paid = workflow !== "build" && !$("prepare-only").checked;
  $("consent-label").hidden = !paid;
  $("start-operation").disabled = busy || Boolean(activeId) || paid && !$("paid-consent").checked;
  $("start-operation").textContent = workflow === "build" ? "Capture build" : paid ? workflow === "suite" ? "Prepare and run suite" : "Prepare and start run" : workflow === "suite" ? "Prepare suite" : "Prepare comparison";
  $("inference-note").textContent = workflow === "build" ? "No model inference. A builder image must already be available."
    : paid ? "This starts model requests using your local authentication and quota. API-equivalent costs are estimates, not subscription charges."
    : workflow === "suite" ? "Prepares fresh pinned tasks and runs model-free preflight. It makes no model requests."
    : "Preparation may clone the NVM source and rebuild a missing or stale image. It makes no model requests.";
}
function launchRequest() {
  const options = formOptions($("launch-form"));
  if (workflow === "pair") {
    if (options.preset === "custom") options.arms = JSON.stringify(customArmRows());
    const imports = importedArmRows();
    if (imports.length) options["import-arms"] = JSON.stringify(imports);
    if (imports.length && options["evaluation-mode"] === "reuse") {
      const mappings = options.preset === "custom" ? [...$("custom-arms").children].flatMap((row, i) => {
        const arm = i === 0 ? "stock" : i === 1 ? "current" : "arm-" + (i + 1);
        return imports.some(item => item.target_arm === arm) ? [] : [[arm, row.querySelector(".evaluation-baseline select").value]];
      }) : [...$("paired-evaluation-baselines").querySelectorAll("select")].map(input => [input.dataset.arm, input.value]);
      options["evaluation-baselines"] = JSON.stringify(Object.fromEntries(mappings));
    }
    const flags = [];
    for (const name of [...MEKUGI_TOGGLES.map(([name]) => name), ...MEKUGI_VALUES]) {
      const key = "mekugi-" + name;
      const input = $("f-" + key);
      delete options[key];
      if (!input || input.disabled) continue;
      if (input.type === "checkbox") flags.push(`--${name}=${input.checked}`);
      else if (input.value.trim()) flags.push(`--${name}=${input.value.trim()}`);
    }
    if (flags.length) options["mekugi-flags"] = JSON.stringify(flags);
  }
  const command = workflow === "pair" ? "launch" : workflow === "suite" ? "prepare-suite" : "build-mekugi";
  const body = { command, options };
  if (workflow === "pair") {
    if ($("prepare-only").checked) options["prepare-only"] = true;
    else if ($("paid-consent").checked) options["confirm-paid-inference"] = true;
  }
  if (workflow === "suite") {
    body.authFile = options["suite-auth-file"] || config.defaults["auth-file"];
    delete options["suite-auth-file"];
    body.runAfterPrepare = !$("prepare-only").checked;
    body.confirmPaid = $("paid-consent").checked;
  }
  return body;
}
async function perform(id, endpoint, body) {
  if (busy || !body) return;
  busy = true; updateConsent();
  showNotice(id, endpoint === "check" ? "Checking local inputs…" : "Starting local operation…");
  try {
    const result = await api(endpoint, body);
    if (endpoint === "check") showNotice(id, "Inputs checked. " + (result.warnings.join(" ") || "The CLI checks evidence identity before execution."));
    else {
      $("paid-consent").checked = false;
      if ($("a-confirm-paid-inference")) $("a-confirm-paid-inference").checked = false;
      activeId = result.id;
      showNotice(id, "Operation started");
      await selectEntry(result.id);
    }
  } catch (error) { showNotice(id, error.message, true); }
  finally { busy = false; updateConsent(); }
}
function tree(value, depth = 0, names = {}, passes = []) {
  names = assessmentNames(value, { ...names, ...obj(obj(value).arm_labels) });
  const judge = obj(obj(value).judge), recordedPasses = obj(judge.result).passes ?? judge.passes;
  if (Array.isArray(recordedPasses)) passes = recordedPasses;
  if (value === null || value === undefined) return '<span class="hint">Unknown</span>';
  if (typeof value !== "object") return esc(typeof value === "boolean" ? value ? "Yes" : "No" : displayName(value, names));
  if (depth > 9) return "<pre>" + esc(displayName(JSON.stringify(value, null, 2), names)) + "</pre>";
  const entries = Object.entries(value);
  const label = (key) => displayName(key.startsWith("current_minus_stock") && names.current && names.stock
    ? `${names.current} minus ${names.stock}${words(key.slice("current_minus_stock".length))}` : Object.hasOwn(names, key) ? names[key] : words(key), names);
  const scalar = entries.filter(([, item]) => item === null || typeof item !== "object");
  const nested = entries.filter(([, item]) => item !== null && typeof item === "object");
  return (scalar.length ? "<dl>" + scalar.map(([key, item]) => "<dt>" + esc(label(key)) + "</dt><dd>" + tree(item, depth + 1, names, passes) + "</dd>").join("") + "</dl>" : "")
    + nested.map(([key, item]) => "<details><summary>" + esc(label(key)) + (Array.isArray(item) ? " (" + item.length + ")" : "") + "</summary>" + tree(item, depth + 1, semanticNames(key, passes, names), passes) + "</details>").join("");
}
function disclosure(title, value, names, passes) {
  return '<details class="tree"><summary>' + esc(title) + "</summary><div>" + tree(value, 0, names, passes) + "</div></details>";
}
function metricTable(report, state, labels) {
  const arms = obj(report.arms);
  const results = obj(state.results);
  const values = (arm) => ({ result: obj(obj(arms[arm]).result ?? results[arm]), totals: obj(obj(arms[arm]).usage).complete === false ? {} : obj(obj(obj(arms[arm]).usage).totals) });
  const keys = Object.keys(labels);
  const criteria = report.criteria ?? state.criteria;
  const rows = [
    ["Behavioral grade", arm => gradeChip(values(arm).result, criteria), "", true],
    ["Agent time", arm => duration(values(arm).result.agent_elapsed_ms) + (values(arm).result.recovery ? " (recovered Docker container duration)" : ""), "agent_elapsed_ms"],
    ["Estimated API cost", arm => typeof values(arm).totals.estimated_api_usd === "number" ? "$" + metric(values(arm).totals.estimated_api_usd, 6) : "Unknown", "estimated_api_usd"],
    ["Total tokens", arm => metric(values(arm).totals.total_tokens), "total_tokens"],
    ["Command time", arm => typeof values(arm).totals.command_seconds === "number" ? metric(values(arm).totals.command_seconds, 2) + " s" : "Unknown", "command_seconds"],
  ];
  const change = (arm, key) => {
    if (key === "agent_elapsed_ms" && (values(arm).result.recovery?.timing_source || "native-controller") !== (values(keys[0]).result.recovery?.timing_source || "native-controller")) return "Not available";
    const changes = obj(obj(report.baseline_differences_percent)[arm] ?? (arm === "current" ? report.current_minus_stock_percent : null));
    return typeof changes[key] === "number" && Number.isFinite(changes[key]) ? (changes[key] > 0 ? "+" : "") + metric(changes[key], 2) + "%" : "Not available";
  };
  return '<div class="table-scroll" tabindex="0" role="region" aria-label="Pair measurements"><table><thead><tr><th>Measurement</th>' + keys.map((arm, index) => '<th class="' + (index === 0 ? "a" : "b") + '">' + esc(labels[arm]) + "</th>").join("") + "</tr></thead><tbody>"
    + rows.map(([label, value, key, html]) => "<tr><th>" + esc(label) + "</th>" + keys.map((arm, index) => '<td class="metric ' + (index === 0 ? 'a' : 'b') + '">' + (html ? value(arm) : esc(value(arm))) + (key && index ? '<span class="metric-change">' + esc(change(arm, key)) + "</span>" : "") + "</td>").join("") + "</tr>").join("") + '</tbody></table></div><p class="hint">' + (keys.length === 2 ? 'Change compares ' + esc(labels[keys[1]]) + ' with ' : 'Changes compare each setup with ') + esc(labels[keys[0]]) + ". Positive percentages mean more time, cost, or tokens, not better quality.</p>";
}
function recoveryNotice(report, state, labels) {
  const recovered = Object.keys(labels).flatMap(arm => {
    const result = obj(obj(obj(report.arms)[arm]).result ?? obj(state.results)[arm]);
    return result.recovery ? [[arm, result.recovery]] : [];
  });
  if (!recovered.length) return "";
  return '<div class="notice"><strong>Recovered evidence</strong><ul>' + recovered.map(([arm, item]) => '<li><strong>' + esc(labels[arm])
    + '</strong>: recovered from run ' + esc(item.source_run_id) + ', arm ' + esc(item.source_arm) + '; collected ' + esc(item.collected_at)
    + '. Timing: Docker container duration (docker-inspect). Native controller elapsed time unavailable.<ul>'
    + (item.caveats || []).map(caveat => '<li>' + esc(caveat) + '</li>').join('') + '</ul></li>').join('')
    + '</ul><p>Cross-source duration rankings and percentages are unavailable.</p></div>';
}
function statusChip(status, text = words(status)) {
  return '<span class="status-chip ' + esc(status) + '">' + esc(text) + "</span>";
}
function gradeChip(result, criteria) {
  const grade = obj(obj(result).grade);
  const semantic = obj(grade.semantic);
  const required = obj(obj(criteria).contract).criteria;
  // An assessed failure settles the grade even when other checks remain unassessed.
  const failed = grade.passed === false && Object.values(semantic).flat().some((item) => obj(item).status === "fail");
  const covered = Array.isArray(required) && [1, 2].every((pass) => {
    const assessed = semantic["pass-" + pass], existing = semantic["pass-" + pass + "-existing"];
    return Array.isArray(assessed) && assessed.length === required.length
      && assessed.every((item) => item.status !== "unassessed" && (item.basis === "executed" || item.status === "fail"))
      && Array.isArray(existing) && existing.length === 1
      && existing.every((item) => item.status !== "unassessed" && item.basis === "executed");
  });
  const pending = !Array.isArray(required) || grade.evaluator_error || (!failed && (!covered
    || [grade.preparation, grade.router_suite].some((check) => obj(check).command === "not run" || obj(check).exit_code === -1)));
  const passed = pending ? undefined : grade.passed;
  return passed === true ? statusChip("pass", "Passed") : passed === false ? statusChip("fail", "Failed") : statusChip("unassessed", "Not graded");
}
function armGrade(report, state, arm) {
  return obj(obj(obj(obj(report.arms)[arm]).result).grade ?? obj(obj(state.results)[arm]).grade);
}
function passKeys(semantic) {
  return Object.keys(obj(semantic)).filter((key) => /^pass-\d+$/.test(key)).sort();
}
function criteriaCount(items) {
  const counts = {};
  for (const item of items) counts[obj(item).status] = (counts[obj(item).status] || 0) + 1;
  if (items.length && counts.pass === items.length) return items.length + "/" + items.length + " criteria pass";
  return ["pass", "fail", "unassessed"].filter((status) => counts[status]).map((status) => counts[status] + " " + status).join(" · ") || "No criteria recorded";
}
// Judge passes keyed by arm. Candidate IDs are positional per pass, so map them through each pass's presentation order.
function judgedPasses(report) {
  const passes = obj(obj(report.judge).result).passes;
  return (Array.isArray(passes) ? passes : []).map((pass) => {
    const order = Array.isArray(pass.presentation) ? pass.presentation : [];
    const arm = (id) => order[Number(String(id).replace("candidate-", "")) - 1] || id;
    const scores = {};
    for (const [id, value] of Object.entries(obj(pass.scores))) scores[arm(id)] = obj(value);
    return { pass: pass.pass, winner: arm(pass.winner), scores };
  });
}
function scoreRubricId(score, scoring) {
  return score.rubric || obj(scoring).legacy_rubric || "legacy";
}
function scoreRubricLabel(score, scoring) {
  return obj(obj(obj(scoring).rubrics)[scoreRubricId(score, scoring)]).label || (score.rubric ? words(score.rubric) : "Legacy recorded rubric");
}
function scoreAxisLabel(key, scoring) {
  return obj(obj(scoring).labels)[key] || words(key).replace(/^./, char => char.toUpperCase());
}
function verdictSummary(report, state, labels, complete) {
  const name = (arm) => arm === "tie" ? "tie" : arm === "none" || !arm ? "neither" : labels[arm] || "Unmapped setup";
  const winner = report.winner;
  const headline = Object.hasOwn(labels, winner) ? "Overall winner: " + labels[winner] : winner === "tie" ? "Overall result: tie" : "No overall winner";
  const passes = judgedPasses(report);
  const agreement = obj(obj(report.judge).result).agreement;
  const judged = passes.length ? " Judge: " + passes.map((pass) => "pass " + pass.pass + " chose " + name(pass.winner)).join(", ") + (typeof agreement === "boolean" ? agreement ? "; passes agree." : "; passes disagree." : ".") : "";
  const settled = complete && [...Object.keys(labels), "tie"].includes(winner);
  const card = (arm, side) => {
    const semantic = armGrade(report, state, arm).semantic;
    const lines = passKeys(semantic).map((key) => {
      const number = Number(key.slice(5));
      const score = obj(passes.find((pass) => pass.pass === number)?.scores[arm]);
      const total = score.weighted_total;
      const existing = obj((obj(semantic)[key + "-existing"] || [])[0]).status;
      return "<li><strong>Pass " + number + "</strong> " + esc(criteriaCount(Array.isArray(semantic[key]) ? semantic[key] : []))
        + (typeof total === "number" ? " · score " + esc(metric(total, 1)) + "/100 (" + esc(scoreRubricLabel(score, report.scoring)) + ")" : "")
        + (existing && existing !== "pass" ? " · existing tests " + esc(words(existing)) : "") + "</li>";
    });
    return '<article class="verdict-card ' + side + '"><h4>' + esc(labels[arm]) + "</h4>" + gradeChip({ grade: armGrade(report, state, arm) }, report.criteria ?? state.criteria)
      + (lines.length ? "<ul>" + lines.join("") + "</ul>" : '<p class="hint">No criterion results recorded.</p>') + "</article>";
  };
  return '<div class="result-summary' + (settled ? "" : " warn") + '"><strong>' + esc(headline) + "</strong><p>" + esc(report.winner_reason || report.comparison_exclusion || "Interpret the available evidence with its validity gates.") + "</p>"
    + '<p class="hint">' + (complete ? "Measurement complete." : "Measurement incomplete.") + esc(judged) + "</p></div>"
    + '<div class="verdict-grid">' + Object.keys(labels).map((arm, index) => card(arm, index === 0 ? "a" : "b")).join("") + "</div>";
}
function scoreTable(report, labels) {
  const passes = judgedPasses(report);
  if (!passes.length) return "";
  const keys = Object.keys(labels);
  const scoring = obj(report.scoring);
  const scores = passes.flatMap(pass => Object.values(pass.scores));
  const rubrics = [...new Set(scores.map(score => scoreRubricId(score, scoring)))];
  const axes = Object.keys(obj(scoring.labels));
  if (!axes.length) axes.push(...new Set([...scores.flatMap(score => Object.keys(score).filter(key => key !== "weighted_total" && key !== "rubric")), ...QUALITY_ASPECT_KEYS]));
  const weights = rubrics.length === 1 ? obj(obj(obj(scoring.rubrics)[rubrics[0]]).weights) : {};
  const rows = axes.map(key => [key, scoreAxisLabel(key, scoring) + (typeof weights[key] === "number" ? " (" + weights[key] + "%)" : "")]);
  rows.push(["weighted_total", "Recorded weighted total (of 100)"]);
  const cell = (pass, arm, key, side) => {
    const value = obj(pass.scores[arm])[key];
    const lead = rubrics.length === 1 && typeof value === "number" && keys.every(other => other === arm || typeof obj(pass.scores[other])[key] === "number" && value > obj(pass.scores[other])[key]);
    const text = value === null || value === undefined && QUALITY_ASPECT_KEYS.includes(key) ? "Unassessed" : metric(value, 2);
    return '<td class="metric ' + side + (lead ? " lead" : "") + '">' + esc(text) + "</td>";
  };
  return '<h3>Judge scores</h3><div class="table-scroll" tabindex="0" role="region" aria-label="Judge scores"><table><thead><tr><th rowspan="2">Score</th>' + keys.map(arm => '<th colspan="' + passes.length + '">' + esc(labels[arm]) + "</th>").join("") + "</tr><tr>"
    + keys.map(() => passes.map(pass => "<th>Pass " + esc(pass.pass) + "</th>").join("")).join("") + "</tr></thead><tbody>"
    + '<tr><th>Scoring rubric</th>' + keys.map(arm => passes.map(pass => '<td>' + esc(scoreRubricLabel(obj(pass.scores[arm]), scoring)) + '</td>').join("")).join("") + '</tr>'
    + rows.map(([key, label]) => "<tr><th>" + esc(label) + "</th>" + keys.map((arm, index) => passes.map((pass, passIndex) => cell(pass, arm, key, passIndex === 0 ? index === 0 ? "a" : "b" : "")).join("")).join("") + "</tr>").join("")
    + '</tbody></table></div><p class="hint">Component scores range from 0 to 5; recorded weighted totals range from 0 to 100. Missing aspect scores and incomplete totals remain unassessed. Bold compares scores only within one rubric.</p>'
    + rubrics.map(id => {
      const rubric = obj(obj(scoring.rubrics)[id]);
      return Object.keys(obj(rubric.weights)).length ? '<p class="hint">' + esc(rubric.label) + ': ' + Object.entries(rubric.weights).map(([key, weight]) => esc(scoreAxisLabel(key, scoring)) + ' ' + esc(weight) + '%').join(', ') + '.</p>' : '';
    }).join("")
    + (report.score_comparison_issue ? '<p class="notice">' + esc(report.score_comparison_issue) + '</p>' : '');
}
function criterionTable(report, labels) {
  const contract = obj(obj(report.criteria).contract);
  const criteria = Array.isArray(contract.criteria) ? contract.criteria : [];
  if (!criteria.length) return "";
  const passes = obj(obj(report.judge).result).passes;
  const findings = (arm, id) => {
    const semantic = obj(obj(obj(obj(report.arms)[arm]).result).grade).semantic;
    return passKeys(semantic).flatMap((key) => (Array.isArray(semantic[key]) ? semantic[key] : []).filter((item) => obj(item).criterion === id)
      .map((item) => ({ key, item, names: semanticNames(key, passes, labels) })));
  };
  const cell = (arm, id, list) => list.length
    ? '<div class="chips">' + list.map(({ key, item }) => statusChip(item.status, "P" + key.slice(5) + " · " + words(item.status))).join("") + '</div><details class="criterion-reasoning" data-key="' + esc(arm + ":" + id) + '"><summary>Reasoning</summary>'
      + list.map(({ key, item, names }) => '<div class="criterion-finding"><p class="hint">' + esc(words(key)) + " · " + esc(item.basis) + "</p><p>" + esc(displayName(item.reasoning, names)) + "</p></div>").join("") + "</details>"
    : '<span class="hint">Not assessed</span>';
  const keys = Object.keys(labels);
  return '<h3>Criterion outcomes</h3><p class="hint">Highlighted rows differ between setups. Expand Reasoning for each pass evidence.</p><div class="table-scroll" tabindex="0" role="region" aria-label="Criterion outcomes"><table class="criteria"><thead><tr><th>Criterion</th>' + keys.map((arm, index) => '<th class="' + (index === 0 ? "a" : "b") + '">' + esc(labels[arm]) + "</th>").join("") + '</tr></thead><tbody>'
    + criteria.map(item => {
      const lists = keys.map(arm => findings(arm, item.id));
      const differs = new Set(lists.map(list => JSON.stringify(list.map(({ item: found }) => found.status)))).size > 1;
      return "<tr" + (differs ? ' class="differs"' : "") + "><th>" + esc(item.id) + '<p class="hint">' + esc(item.description) + '</p></th>' + keys.map((arm, index) => "<td>" + cell(arm, item.id, lists[index]) + "</td>").join("") + "</tr>";
    }).join("") + "</tbody></table></div>";
}
function resourceSummary(report) {
  const comparisons = Array.isArray(report.resource_explanation) ? report.resource_explanation : [];
  const findings = Array.isArray(obj(report.workflow_mechanisms).findings) ? report.workflow_mechanisms.findings : [];
  return '<h3>Why token and request usage differs</h3>'
    + (comparisons.length ? comparisons.map((item) => '<section class="assessment-pass"><p>' + esc(item.summary) + '</p><ul>' + (Array.isArray(item.drivers) ? item.drivers : []).map((driver) => '<li>' + esc(driver) + '</li>').join('') + '</ul></section>').join('')
      : '<p class="hint">Regenerate the report to explain resource differences from retained usage. Single-arm runs have no comparison.</p>')
    + (findings.length ? '<h4>Observed workflow contributors</h4><ul>' + [...new Set(findings.map((item) => item.mechanism))].map((title) => '<li>' + esc(title) + '</li>').join('') + '</ul>'
      + '<details class="assessment-details" data-key="workflow-causes"><summary>Workflow evidence and limits</summary>' + findings.map((item) => '<p><strong>' + esc(item.mechanism) + '</strong></p><p>' + esc(item.explanation) + '</p><ul>' + (item.evidence || []).map((evidence) => '<li>' + esc(evidence) + '</li>').join('') + '</ul><p class="hint">' + esc(item.limitation) + '</p>').join('') + '</details>'
      : '<p class="hint">The recorded workflow does not establish why extra requests occurred. Request counts alone cannot identify the responsible instruction, retries, or cache-miss cause.</p>')
    + '<p class="hint">Accounting locates the difference; observed workflow contributors do not establish a general causal effect from one run.</p>';
}
function qualityAspectsTable(pass, names, scoring) {
  const order = Array.isArray(pass.presentation) ? pass.presentation : [];
  if (!order.length) return "";
  const cell = (index, key) => {
    const id = "candidate-" + (index + 1);
    const aspect = obj(obj(obj(pass.quality_aspects)[id])[key]);
    return statusChip(aspect.status || "unassessed")
      + '<details class="criterion-reasoning" data-key="' + esc("aspect:" + pass.pass + ":" + order[index] + ":" + key) + '"><summary>Reasoning</summary><p class="hint">Evidence: '
      + esc(aspect.basis || "none") + "</p><p>" + esc(displayName(aspect.reasoning || "No qualitative assessment was recorded for this historical candidate.", names)) + "</p></details>";
  };
  return '<h4>Qualitative aspects</h4><p class="hint">Aspect evidence supports the expanded numeric scores. Missing numeric evidence stays unassessed; functional gates are unchanged. Implementation performance is separate from agent command time.</p><div class="table-scroll" tabindex="0" role="region" aria-label="Qualitative aspects, pass ' + esc(pass.pass) + '"><table><thead><tr><th>Aspect</th>'
    + order.map((_, index) => "<th>" + esc(displayName("candidate-" + (index + 1), names)) + "</th>").join("") + "</tr></thead><tbody>"
    + QUALITY_ASPECT_KEYS.map(key => "<tr><th>" + esc(scoreAxisLabel(key, scoring)) + "</th>" + order.map((_, index) => '<td class="criterion-finding">' + cell(index, key) + "</td>").join("") + "</tr>").join("") + "</tbody></table></div>";
}
function judgeSummary(judge, labels, scoring) {
  const result = obj(obj(judge).result);
  if (!Array.isArray(result.passes) || !result.passes.length) return "";
  return '<h3>Source assessment: why quality differs</h3><p class="hint">Implementation causes and observed consequences. Full supporting evidence remains available below each explanation.</p>' + result.passes.map((pass) => {
    const names = assessmentNames(pass, labels);
    const issues = Array.isArray(pass.issues) ? pass.issues : [];
    const causes = [...new Set(issues.map((issue) => issue.candidate))].map((candidate) => issues.find((issue) => issue.candidate === candidate && issue.severity === 'critical') || issues.find((issue) => issue.candidate === candidate && issue.severity !== 'minor')).filter(Boolean);
    return '<section class="assessment-pass"><h4>Pass ' + esc(pass.pass) + " winner: " + esc(displayName(pass.winner, names)) + "</h4><p>" + esc(displayName(pass.rationale || "No reasoning recorded for this pass.", names)) + "</p>"
      + qualityAspectsTable(pass, names, scoring)
      + (causes.length ? '<ul class="assessment-issues">' + causes.map((issue) => '<li><strong>' + esc(displayName(issue.candidate, names)) + '</strong>: ' + esc(displayName(issue.detail, names)) + '</li>').join('') + '</ul>' : '')
      + '<details class="assessment-details" data-key="assessment-' + esc(pass.pass) + '"><summary>Full evidence and issues</summary>'
      + (Array.isArray(pass.evidence) ? "<ul>" + pass.evidence.map((item) => "<li>" + esc(displayName(item, names)) + "</li>").join("") + "</ul>" : "")
      + (issues.length ? '<ul class="assessment-issues">' + issues.map((issue) => '<li><strong>' + esc(displayName(issue.candidate, names)) + (issue.severity ? ": " + esc(issue.severity) : "") + "</strong><p>" + esc(displayName(issue.detail, names)) + "</p></li>").join("") + "</ul>" : "") + "</details></section>";
  }).join("");
}
function resultContent(data) {
  const state = obj(data.state), report = obj(data.report);
  const labels = setupLabels(data);
  const currentInvalidity = Array.isArray(state.invalidity_reasons) ? state.invalidity_reasons : [];
  const invalidated = currentInvalidity.length > 0;
  const invalidationNotice = invalidated ? '<div class="notice error"><strong>Interpretation invalidated</strong><p>' + esc(currentInvalidity.join("\n")) + "</p><p>Regenerate the report to update exported evidence. Recorded measurements remain available below.</p></div>" : "";
  if (data.entry.kind === "build") return "<h2>Captured build</h2><p class='hint'>Build identity is available when capture succeeds. Failed builds retain their available logs.</p>" + disclosure("Build identity and retained outcome", state);
  if (!data.state && !data.report || state.status === "prepared" && !Object.keys(obj(state.results)).length) {
    const status = obj(data.entry.job).status;
    const stopped = ["failed", "canceled", "complete"].includes(status) || obj(state.finishing).status === "failed";
    return "<h2>" + (stopped ? "No results collected" : "Preparing comparison") + "</h2><p class='hint'>"
      + (stopped ? "The operation ended before candidate results were collected. See the operation status and phase log."
        : "Preparing isolated workspaces and recording runtime metadata. Setup identities and measurements appear after preparation publishes the run state. Follow the phase log for progress.") + "</p>";
  }
  if (!Object.keys(report).length) return "<h2>Partial results</h2>" + invalidationNotice + recoveryNotice({}, state, labels) + "<p class='hint'>The report appears when the CLI generates it. Collected grades remain visible while work continues.</p>" + (data.entry.kind === "pair" ? metricTable({}, state, labels) : "");
  if (data.entry.kind === "pair") {
    const warnings = [...new Set([...currentInvalidity, ...(report.invalidity_reasons || []), ...Object.values(obj(report.arms)).flatMap((arm) => obj(arm.usage).warnings || [])])];
    const complete = report.measurement_complete === true && !invalidated;
    const evaluation = obj(report.evaluation ?? state.evaluation);
    const evaluationNote = evaluation.mode === "reuse" ? '<p class="notice">Historical evaluation reused. Imported grades and scores are unchanged; fresh candidates use adapted historical tests. Scores retain their recorded rubrics; different rubrics cannot produce an overall quality winner.</p>'
      + '<ul>' + Object.entries(obj(evaluation.baselines)).map(([arm, baseline]) => '<li>' + esc(labels[arm]) + ': tests and assessment baseline from ' + esc(labels[baseline]) + '</li>').join("") + '</ul>' : "";
    return "<h2>Comparison results</h2>" + recoveryNotice(report, state, labels) + "<p class='hint'>" + esc(report.design || "Descriptive paired evidence") + "</p>" + evaluationNote
      + (invalidated ? invalidationNotice : verdictSummary(report, state, labels, complete))
      + scoreTable(report, labels)
      + "<h3>Measurements</h3>" + metricTable(report, state, labels)
      + (warnings.length ? '<ul class="warning-list">' + warnings.map((warning) => "<li>" + esc(warning) + "</li>").join("") + "</ul>" : "")
      + (invalidated || report.validity === "invalid" ? "" : judgeSummary(report.judge, labels, report.scoring))
      + resourceSummary(report) + criterionTable(report, labels)
      + disclosure(invalidated ? "Technical report, regenerate after invalidation" : "Technical report", report, labels);
  }
  if (data.entry.kind === "trials") {
    const comparisons = obj(report.baseline_comparisons ?? { current: report.current_minus_stock });
    const baseline = report.baseline_arm || "stock";
    const tables = Object.entries(comparisons).map(([arm, values]) => {
      const rows = Object.entries(obj(values)).map(([name, value]) => {
        const stats = obj(value);
        return "<tr><th>" + esc(words(name)) + "</th><td>" + metric(obj(stats.stock).mean, 3) + "</td><td>" + metric(obj(stats.current).mean, 3) + "</td><td>" + metric(obj(stats.difference).mean, 3) + "</td><td>" + metric(obj(stats.percent).mean, 2) + "</td><td>" + metric(obj(stats.difference).n) + "</td></tr>";
      }).join("");
      return "<h3>" + esc(labels[arm]) + " minus " + esc(labels[baseline]) + '</h3><div class="table-scroll" tabindex="0" role="region" aria-label="Trial statistics"><table><thead><tr><th>Metric</th><th>' + esc(labels[baseline]) + ' mean</th><th>' + esc(labels[arm]) + ' mean</th><th>Difference mean</th><th>Percent mean</th><th>Runs</th></tr></thead><tbody>' + rows + "</tbody></table></div>";
    }).join("");
    return "<h2>Trial-set results</h2><p>" + metric(report.eligible_pairs) + " eligible runs of " + metric(report.planned_pairs) + " planned.</p><p class='hint'>Unavailable metrics are excluded. These observations do not establish causality.</p>" + tables
      + disclosure("Distributions, medians and sample variation", comparisons, labels)
      + disclosure("Run eligibility, results and source assessments", report.pairs, labels)
      + disclosure("Complete trial report", report, labels);
  }
  if (data.entry.kind === "suite") {
    const rows = (report.rows || []).map((row) => "<tr><th>" + esc(row.task) + "</th><td>" + esc(row.setup) + "</td><td>" + metric(row.planned) + "</td><td>" + metric(row.measured) + "</td><td>" + metric(row.both_pass) + "</td></tr>").join("");
    return "<h2>Suite results</h2><p class='hint'>Time and cost effects include eligible, complete, both-passing pairs. Macro statistics weight tasks equally.</p>"
      + '<div class="table-scroll" tabindex="0" role="region" aria-label="Suite measurements"><table><thead><tr><th>Task</th><th>Setup</th><th>Planned</th><th>Measured</th><th>Both pass</th></tr></thead><tbody>' + rows + "</tbody></table></div>"
      + disclosure("Per-task time and cost effects", report.effects) + disclosure("Equal-task macro statistics", report.macro) + disclosure("Complete suite report", report);
  }
  return "<h2>Captured build</h2>" + disclosure("Build identity", state);
}
function actionFields(entry) {
  const actions = config.actions[entry.kind] || [];
  $("existing-actions").hidden = !actions.length || !entry.directory;
  if (!actions.length || !entry.directory) return;
  const names = { preflight: "Model-free preflight", run: "Run prepared pair", "prepare-trials": "Prepare fresh trials from this pair", judge: "Source assessment", finish: "Finish completed execution", report: "Generate report", remeter: "Correct usage metering", invalidate: "Invalidate interpretation", "run-trials": "Run prepared trial set", "report-trials": "Generate trial report", "run-suite": "Run prepared suite", "report-suite": "Generate suite report" };
  $("action-fields").innerHTML = select("Action", "action-command", actions.map((name) => [name, names[name]]), actions[0], "", "a") + '<div class="grid" id="action-options"></div>';
  $("a-action-command").addEventListener("change", updateActionFields);
  updateActionFields();
}
function updateActionFields() {
  const command = $("a-action-command").value;
  const setups = setupLabels(snapshot || {});
  const targetKeys = new Set(["run-dir", "trial-set", "suite-run"]);
  const fields = config.commands[command].filter((key) => !targetKeys.has(key));
  const labels = { "import-arms": "Previous arm mappings (JSON, optional)", arm: "Selected arm (optional)", "control-run": "Completed stock control directory (optional)", "control-bundle-sha256": "Control bundle SHA-256 (optional)", "recover-judge": "Recover eligible failed judge stages", "source-assessments": "Supplied source-assessment JSON (optional)", exclusions: "Usage exclusions JSON file", reason: "Invalidation reason", "output-dir": "Report output directory (optional)", count: "Fresh pair count", order: "Trial arm order", "auth-file": "Codex authentication file", "grok-auth-file": "Grok authentication file", "docker-bin": "Docker executable", "output-parent": "Output parent (optional)" };
  $("action-options").innerHTML = fields.map((key) => {
    if (key === "confirm-paid-inference") return check("I authorize paid inference for this action", key, "a");
    if (["recover-judge", "protect-mekugi"].includes(key)) return check(labels[key] || words(key), key, "a");
    if (key === "arm") return select("Selected setup (optional)", key, [["", "All setups"], ...Object.entries(setups)], "", "", "a");
    if (key === "order") return select(labels[key], key, [["concurrent", "Concurrent"], ["alternating", "Alternating"]], "concurrent", "", "a");
    return field(labels[key] || words(key), key, key === "count" ? "2" : config.defaults[key] || "", key === "count" ? "number" : "text", "", "a");
  }).join("");
  $("action-status").textContent = "";
}
function actionRequest() {
  if (snapshot?.entry.id !== selected) {
    showNotice("action-status", "Load the selected evidence before starting an action", true);
    return null;
  }
  const options = formOptions($("action-form"));
  const command = options["action-command"];
  delete options["action-command"];
  return { command, options, entryId: selected };
}
function renderArtifacts() {
  const filter = $("artifact-filter").value.toLowerCase();
  const signature = JSON.stringify([selected, artifactItems, filter]);
  if (signature === artifactSignature) return;
  artifactSignature = signature;
  const matches = artifactItems.filter((file) => file.path.toLowerCase().includes(filter));
  $("artifact-note").textContent = artifactItems.length ? "Showing " + matches.length + " of " + artifactItems.length + " evidence files (up to 500). Private homes and authentication stores stay excluded." : "Reports, patches and logs appear as the CLI writes them.";
  $("artifacts").innerHTML = "<ul>" + matches.map((file) => '<li><a href="/api/entries/' + selected + "/artifacts?path=" + encodeURIComponent(file.path) + '">' + esc(file.path) + '</a> <span class="hint">(' + metric(file.bytes) + " bytes)</span></li>").join("") + "</ul>";
}
async function copyReference() {
  const field = $("run-reference"), reference = field.value;
  if (!reference) return;
  try {
    await navigator.clipboard.writeText(reference);
    if (field.value === reference) showNotice("reference-status", "Evidence reference copied, including the absolute directory.");
  } catch {
    if (field.value !== reference) return;
    field.hidden = false; field.focus(); field.select();
    showNotice("reference-status", "Clipboard unavailable. Copy the selected reference below.");
  }
}
function renderSnapshot(data) {
  snapshot = data;
  const labels = setupLabels(data);
  const entry = data.entry, state = obj(data.state), job = obj(entry.job);
  $("run-title").textContent = entry.title;
  $("run-directory").textContent = entry.directory || "Preparing the local environment; the evidence directory will appear here.";
  $("copy-reference").disabled = !entry.directory;
  $("compare-head").hidden = entry.kind !== "pair" || state.status !== "complete";
  $("run-reference").value = entry.directory ? `${entry.title}\nEvidence directory: ${entry.directory}\nWorkbench entry: ${entry.id}` : "";
  $("stop-operation").hidden = activeId !== entry.id;
  $("stop-operation").disabled = job.status === "stopping";
  $("stop-operation").textContent = job.status === "stopping" ? "Stopping and retaining evidence…" : "Stop operation";
  const statuses = obj(state.arm_attempts);
  const errors = [job.error, state.error, obj(state.finishing).error, obj(state.judge).error].filter(Boolean);
  const phaseItems = entry.kind === "pair" && !data.state ? [["Preparation", job.status || "Preparing"]] : entry.kind === "pair" ? [
    ...Object.keys(labels).map(arm => [labels[arm] + " execution", ...executionStatus(statuses[arm], obj(state.results)[arm])]),
    ["Source assessment", obj(state.judge).status || "Not started", TONES[obj(state.judge).status]],
    ["Report finishing", obj(state.finishing).status || (data.report ? "Report available" : "Not started"), TONES[obj(state.finishing).status]],
  ] : [["Evidence", state.status || "Preparing"], ["Operation", job.status || "Attached"], ["Completed children", data.children.filter((child) => child.status === "complete").length + " of " + data.children.length], ["Report", data.report ? "Available" : "Not yet generated"]];
  $("run-status").innerHTML = '<div class="status-line"><span class="badge ' + esc(job.status || state.status || "prepared") + '">' + esc(job.status || "attached") + "</span><span>Evidence: " + esc(state.status || "not yet prepared") + '</span><span>Operation elapsed: <span id="operation-elapsed"></span></span></div>'
    + '<div class="phases">' + phaseItems.map(([title, value, tone]) => "<div><strong>" + esc(title) + '</strong><span class="' + esc(tone || "") + '">' + esc(value) + "</span></div>").join("") + "</div>"
    + (errors.length ? '<p class="notice error">' + esc([...new Set(errors)].join("\n")) + "</p>" : "");
  renderElapsed();
  const log = $("phase-log");
  const atBottom = log.scrollHeight - log.clientHeight - log.scrollTop < 40;
  log.textContent = job.log || "No phase messages from this server operation. Attached runs expose persisted state and setup output below.";
  if ($("follow-log").checked && atBottom) log.scrollTop = log.scrollHeight;
  const live = Object.entries(obj(entry.kind === "pair" ? data.live_html : data.live));
  const keys = live.map(([arm]) => arm).join(",");
  if (liveKeys !== keys) {
    $("live-output").innerHTML = live.map(([arm]) => '<details class="panel" open><summary></summary><div tabindex="0" role="region" class="' + (entry.kind === "pair" ? "rendered-output" : "log") + '" data-live="' + esc(arm) + '"></div></details>').join("");
    liveKeys = keys;
  }
  for (const [arm, text] of live) {
    const element = $("live-output").querySelector('[data-live="' + arm + '"]');
    element.previousElementSibling.textContent = (arm.startsWith("build") ? words(arm) : labels[arm] || "Setup unavailable") + " output";
    element.setAttribute("aria-label", element.previousElementSibling.textContent);
    const wasAtBottom = element.scrollHeight - element.clientHeight - element.scrollTop < 40;
    if (entry.kind === "pair") {
      const html = obj(data.live_html)[arm] || '<p class="hint">Waiting for readable output…</p>';
      if (element.innerHTML !== html) element.innerHTML = html;
    } else if (element.textContent !== text) element.textContent = text;
    if ($("follow-log").checked && wasAtBottom) element.scrollTop = element.scrollHeight;
  }
  if (childSignature !== JSON.stringify(data.children)) {
    $("children").innerHTML = data.children.map((child) => '<button data-entry="' + child.id + '"><strong>' + esc(child.title) + "</strong> · " + esc(child.status || "preparing") + (child.error ? '<span class="error"> ' + esc(child.error) + "</span>" : "") + "</button>").join("");
    childSignature = JSON.stringify(data.children);
  }
  const signature = JSON.stringify([data.report, data.arm_labels, Boolean(data.state), job.status, entry.kind === "build" ? state : state.results, state.invalidity_reasons]);
  if (reportSignature !== signature) {
    const key = (detail) => detail.dataset.key || detail.querySelector("summary").textContent;
    const opened = [...$("results").querySelectorAll("details[open]")].map(key);
    $("results").innerHTML = resultContent(data);
    for (const detail of $("results").querySelectorAll("details")) if (opened.includes(key(detail))) detail.open = true;
    reportSignature = signature;
  }
  if (stateSignature !== JSON.stringify([state, labels])) {
    $("state-details").innerHTML = '<div class="tree">' + tree(state, 0, labels) + "</div>"; stateSignature = JSON.stringify([state, labels]);
  }
  artifactItems = data.artifacts; renderArtifacts();
  if (actionEntry !== entry.id + entry.kind + Boolean(entry.directory)) {
    actionFields(entry); actionEntry = entry.id + entry.kind + Boolean(entry.directory);
  }
  for (const option of $("a-arm")?.options || []) if (option.value) option.textContent = labels[option.value];
  $("start-action").disabled = busy || Boolean(activeId);
  $("updated-at").textContent = $("watch-enabled").checked ? "Updated " + new Date().toLocaleTimeString() : "Evidence updates paused. Operation status stays live.";
  $("watch-error").textContent = "";
}
async function selectEntry(id) {
  selected = id; reportSignature = undefined; stateSignature = undefined; actionEntry = undefined;
  snapshot = undefined; latestSnapshot = undefined;
  $("start-action").disabled = true; $("existing-actions").hidden = true;
  $("run-title").textContent = "Loading selected evidence…";
  $("run-directory").textContent = "";
  $("copy-reference").disabled = true;
  $("run-reference").value = ""; $("run-reference").hidden = true;
  $("reference-status").hidden = true;
  for (const element of ["run-status", "results", "action-fields", "live-output", "children", "artifacts", "state-details"]) $(element).replaceChildren();
  $("phase-log").textContent = "Loading selected evidence…";
  liveKeys = undefined; childSignature = undefined; artifactSignature = undefined;
  $("launch-view").hidden = true; $("watch-view").hidden = false;
  $("artifact-filter").value = "";
  history.replaceState(null, "", "#" + id);
  connectEvents();
}
function renderEntries(data) {
  activeId = data.active;
  const signature = JSON.stringify([selected, data.entries.map((entry) => [entry.id, entry.title, entry.kind, obj(entry.job).status])]);
  if (listSignature !== signature) {
    $("run-list").innerHTML = data.entries.length ? data.entries.map((entry) => '<button data-entry="' + entry.id + '" aria-current="' + (selected === entry.id) + '"><strong>' + esc(entry.title) + "</strong><small>" + esc(entry.kind + " · " + (obj(entry.job).status || "attached evidence")) + "</small></button>").join("") : "<p class='hint'>No runs yet. Set up a comparison or attach retained evidence.</p>";
    listSignature = signature;
  }
  $("stop-operation").hidden = activeId !== selected;
  updateConsent();
}
function renderElapsed() {
  const element = $("operation-elapsed");
  if (!element || snapshot?.entry.id !== selected) return;
  const job = obj(snapshot.entry.job);
  element.textContent = job.startedAt ? duration(Date.parse(job.finishedAt || new Date().toISOString()) - Date.parse(job.startedAt)) : "Not measured by this server";
}
function applySnapshotDelta(value, change) {
  if (Object.hasOwn(change, "value")) return change.value;
  if (!change.children) return undefined;
  const result = Array.isArray(value) ? value.slice(0, change.length ?? value.length) : { ...value };
  for (const [key, patch] of Object.entries(change.children)) {
    const next = applySnapshotDelta(value != null && Object.hasOwn(value, key) ? value[key] : undefined, patch);
    if (next === undefined) delete result[key];
    else Object.defineProperty(result, key, { value: next, enumerable: true, configurable: true, writable: true });
  }
  return result;
}
function connectEvents() {
  eventStream?.close();
  const id = selected;
  const stream = new EventSource("/api/events" + (id ? "?entry=" + encodeURIComponent(id) : ""));
  eventStream = stream;
  const current = () => eventStream === stream && selected === id;
  stream.addEventListener("entries", (event) => {
    if (!current()) return;
    renderEntries(JSON.parse(event.data));
    $("connection").textContent = activeId ? "Local service · operation active" : "Local service · ready";
  });
  const receiveSnapshot = (data) => {
    latestSnapshot = data;
    $("watch-error").textContent = "";
    if ($("watch-enabled").checked || !snapshot || data.entry.job?.status !== snapshot.entry.job?.status) renderSnapshot(data);
  };
  stream.addEventListener("snapshot", (event) => {
    if (current()) receiveSnapshot(JSON.parse(event.data));
  });
  stream.addEventListener("snapshot-patch", (event) => {
    if (current() && latestSnapshot) receiveSnapshot(applySnapshotDelta(latestSnapshot, JSON.parse(event.data)));
  });
  stream.addEventListener("snapshot-error", (event) => {
    if (current()) $("watch-error").textContent = JSON.parse(event.data).error;
  });
  stream.onerror = () => {
    if (current()) $("connection").textContent = "Connection lost. Reconnecting automatically. If the service restarted, reload and attach retained evidence.";
  };
}
async function init() {
  try {
    if (window.matchMedia("(max-width: 960px)").matches) $("evidence-nav").open = false;
    config = await api("config");
    drawLaunch();
    $("new-run").addEventListener("click", () => { selected = undefined; $("launch-view").hidden = false; $("watch-view").hidden = true; history.replaceState(null, "", "/"); connectEvents(); });
    document.addEventListener("click", (event) => {
      const button = event.target.closest("[data-entry]");
      if (button) selectEntry(button.dataset.entry).catch((error) => showNotice("watch-error", error.message, true));
    });
    for (const button of document.querySelectorAll("[data-workflow]")) button.addEventListener("click", () => { workflow = button.dataset.workflow; drawLaunch(); });
    $("prepare-only").addEventListener("change", () => { $("paid-consent").checked = false; updateConsent(); });
    $("paid-consent").addEventListener("change", updateConsent);
    $("check-inputs").addEventListener("click", () => perform("input-status", "check", launchRequest()));
    $("launch-form").addEventListener("submit", (event) => { event.preventDefault(); perform("input-status", "start", launchRequest()); });
    $("action-form").addEventListener("submit", (event) => { event.preventDefault(); perform("action-status", "start", actionRequest()); });
    $("check-action").addEventListener("click", () => perform("action-status", "check", actionRequest()));
    $("attach-form").addEventListener("submit", async (event) => {
      event.preventDefault(); $("attach-error").textContent = "Checking evidence directory…";
      try { const entry = await api("attach", { directory: $("attach-directory").value }); $("attach-error").textContent = ""; await selectEntry(entry.id); }
      catch (error) { $("attach-error").textContent = error.message; }
    });
    $("stop-operation").addEventListener("click", async () => {
      $("stop-operation").disabled = true;
      try { await api("entries/" + selected + "/stop", {}); }
      catch (error) { $("watch-error").textContent = error.message; $("stop-operation").disabled = false; }
    });
    $("copy-reference").addEventListener("click", copyReference);
    $("compare-head").addEventListener("click", (event) => compareAgainstHead(snapshot.entry.directory, "reference-status", event.currentTarget));
    $("artifact-filter").addEventListener("input", renderArtifacts);
    $("watch-enabled").addEventListener("change", () => { if ($("watch-enabled").checked && latestSnapshot) renderSnapshot(latestSnapshot); else $("updated-at").textContent = "Evidence updates paused. Operation status stays live."; });
    const hash = location.hash.slice(1);
    if (/^[a-f0-9-]+$/.test(hash)) await selectEntry(hash);
    else connectEvents();
    setInterval(renderElapsed, 1000);
    window.addEventListener("pagehide", () => eventStream?.close());
    window.addEventListener("pageshow", (event) => { if (event.persisted) connectEvents(); });
  } catch (error) { $("connection").textContent = "Cannot connect: " + error.message; }
}
init();
