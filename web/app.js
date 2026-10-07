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
function field(label, name, value = "", type = "text", hint = "", prefix = "f") {
  const id = prefix + "-" + name;
  return '<div class="field"><label for="' + id + '">' + esc(label) + '</label><input id="' + id + '" name="' + esc(name) + '" type="' + type + '" value="' + esc(value) + '" spellcheck="false">' + (hint ? '<p class="hint">' + esc(hint) + '</p>' : "") + "</div>";
}
function select(label, name, options, value = "", hint = "", prefix = "f") {
  const id = prefix + "-" + name;
  return '<div class="field"><label for="' + id + '">' + esc(label) + '</label><select id="' + id + '" name="' + esc(name) + '">' + options.map(([key, text]) => '<option value="' + esc(key) + '"' + (key === value ? " selected" : "") + ">" + esc(text) + "</option>").join("") + "</select>" + (hint ? '<p class="hint">' + esc(hint) + '</p>' : "") + "</div>";
}
function check(label, name, prefix = "f") {
  return '<label class="check"><input id="' + prefix + "-" + name + '" type="checkbox" name="' + name + '">' + esc(label) + "</label>";
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
function drawLaunch() {
  const defaults = config.defaults;
  $("input-status").hidden = true;
  $("prepare-only").checked = true;
  $("paid-consent").checked = false;
  for (const button of document.querySelectorAll("[data-workflow]")) button.setAttribute("aria-pressed", String(button.dataset.workflow === workflow));
  let fields;
  if (workflow === "pair") {
    const task = config.tasks.find((item) => item.id === defaults.task);
    fields = '<div class="grid">'
      + select("Comparison", "preset", config.comparisons.map((item) => [item.id, item.title]), defaults.preset)
      + select("Task", "task", config.tasks.map((item) => [item.id, item.title]), defaults.task)
      + '</div><div id="comparison-preview" class="comparison-preview"></div><p id="comparison-description" class="description"></p><div class="grid">'
      + field("Source checkout", "source", task.source, "text", "Local Git checkout. The default NVM source can be cloned during preparation.")
      + select("Model", "model", [["gpt-6-astra", "GPT-6 Astra"], ["gpt-6.1-sol", "GPT-6.1 Sol"]], defaults.model)
      + select("Reasoning effort", "reasoning-effort", [["", "Task default"], ...["low", "medium", "high", "xhigh"].map((value) => [value, words(value)])], "", "NVM and portable packs: medium. Long-horizon tasks: xhigh. Grok: high.")
      + field("Fresh pair count", "count", "1", "number", "One is a single pair. Two or more create a trial set.")
      + select("Trial arm order", "order", [["concurrent", "Concurrent"], ["alternating", "Alternating first arm"]], "concurrent")
      + '<div id="compaction-limit-field">' + field("Shared compaction token limit", "auto-compact-limit", "", "number", "Required for the journal comparison.") + "</div></div>"
      + '<details class="advanced"><summary>Runtime and resource settings</summary><div class="grid">' + sharedFields()
      + field("Codex authentication file", "auth-file", defaults["auth-file"], "text", "Local path only. Never paste credential contents.")
      + field("Grok authentication file", "grok-auth-file", defaults["grok-auth-file"])
      + '</div></details><details class="advanced"><summary>Mekugi and comparison settings</summary><div class="grid">'
      + select("Current-setup launcher", "current-launcher", [["codex", "Direct Codex"], ["mekugi", "Mekugi"]], "codex", "Applies to minimal versus current setup.")
      + select("Journal compaction override", "journal-compaction", [["", "Mekugi default"], ...["auto", "slice", "off"].map((value) => [value, words(value)])])
      + field("Mekugi source", "mekugi-source", defaults["mekugi-source"])
      + field("Mekugi executable", "mekugi-bin", defaults["mekugi-bin"])
      + field("Captured Mekugi build (optional)", "mekugi-build", "", "text", "Owns its executable and source when supplied.")
      + field("Mekugi flags (JSON array, optional)", "mekugi-flags", "", "text", 'For example ["--mode=mekugi","--duplicate-output=on"].')
      + field("Grok executable", "grok-bin", defaults["grok-bin"])
      + field("Reviewer treatment (optional)", "review-treatment", "", "text", "Use an existing reviewer overlay path.")
      + '</div>' + check("Use protected Mekugi runtime", "protect-mekugi") + '</details>'
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
      $("f-source").closest(".field").querySelector(".hint").textContent = task.id === "booking-ledger"
        ? "Leave blank to create a clean synthetic Git seed during preparation, or reuse a Booking Ledger seed checkout."
        : "Local Git checkout. The default NVM source can be cloned during preparation.";
      if (task.id === "booking-ledger") {
        $("f-preset").value = "stock-mekugi";
        $("f-journal-compaction").value = "auto";
      }
      updateCombination();
    });
    for (const id of ["f-preset", "f-current-launcher", "f-mekugi-build", "f-task-pack"]) {
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
  const mekugi = comparison.id !== "stock-current" || $("f-current-launcher").value === "mekugi";
  const titleB = comparison.id === "stock-current" && mekugi ? "Mekugi · current setup" : comparison.b;
  $("comparison-preview").innerHTML = '<article><span class="arm-id">A</span><h2>' + esc(comparison.a) + '</h2><p>Fresh isolated workspace</p></article><article><span class="arm-id">B</span><h2>' + esc(titleB) + '</h2><p>Same pinned task and resource limits</p></article>';
  $("comparison-description").textContent = comparison.description + (grok ? " The fixed model is Grok 4.7." : "");
  setEnabled("f-model", !grok);
  setEnabled("f-current-launcher", comparison.id === "stock-current");
  setEnabled("f-journal-compaction", mekugi && comparison.id !== "journal-compaction");
  setEnabled("f-auto-compact-limit", comparison.id === "journal-compaction");
  $("compaction-limit-field").hidden = comparison.id !== "journal-compaction";
  const build = $("f-mekugi-build").value.trim();
  for (const id of ["f-mekugi-source", "f-mekugi-bin"]) setEnabled(id, mekugi && !build);
  for (const id of ["f-mekugi-build", "f-mekugi-flags"]) setEnabled(id, mekugi);
  for (const id of ["f-grok-bin", "f-grok-auth-file"]) setEnabled(id, grok);
  setEnabled("f-protect-mekugi", mekugi && ["stock-current", "same-setup"].includes(comparison.id));
  setEnabled("f-review-treatment", !["stock-mekugi", "codex-mekugi-grok"].includes(comparison.id));
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
function tree(value, depth = 0) {
  if (value === null || value === undefined) return '<span class="hint">Unknown</span>';
  if (typeof value !== "object") return esc(typeof value === "boolean" ? value ? "Yes" : "No" : value);
  if (depth > 9) return "<pre>" + esc(JSON.stringify(value, null, 2)) + "</pre>";
  const entries = Object.entries(value);
  const scalar = entries.filter(([, item]) => item === null || typeof item !== "object");
  const nested = entries.filter(([, item]) => item !== null && typeof item === "object");
  return (scalar.length ? "<dl>" + scalar.map(([key, item]) => "<dt>" + esc(words(key)) + "</dt><dd>" + tree(item, depth + 1) + "</dd>").join("") + "</dl>" : "")
    + nested.map(([key, item]) => "<details><summary>" + esc(words(key)) + (Array.isArray(item) ? " (" + item.length + ")" : "") + "</summary>" + tree(item, depth + 1) + "</details>").join("");
}
function disclosure(title, value) {
  return '<details class="tree"><summary>' + esc(title) + "</summary><div>" + tree(value) + "</div></details>";
}
function metricTable(report, state, labels) {
  const arms = obj(report.arms);
  const results = obj(state.results);
  const values = (arm) => ({ result: obj(obj(arms[arm]).result ?? results[arm]), totals: obj(obj(obj(arms[arm]).usage).totals) });
  const a = values("stock"), b = values("current");
  const grade = (data) => typeof obj(data.result.grade).passed === "boolean" ? data.result.grade.passed ? "Passed" : "Failed" : "Not graded";
  const rows = [
    ["Behavioral grade", grade(a), grade(b)],
    ["Agent time", duration(a.result.agent_elapsed_ms), duration(b.result.agent_elapsed_ms)],
    ["Grader time", duration(obj(a.result.grade).elapsed_ms), duration(obj(b.result.grade).elapsed_ms)],
    ...["input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens"].map((name) => [words(name), metric(a.totals[name]), metric(b.totals[name])]),
    ["Command time", metric(a.totals.command_seconds, 2) + (typeof a.totals.command_seconds === "number" ? " s" : ""), metric(b.totals.command_seconds, 2) + (typeof b.totals.command_seconds === "number" ? " s" : "")],
    ["Estimated API cost", typeof a.totals.estimated_api_usd === "number" ? "$" + metric(a.totals.estimated_api_usd, 6) : "Unknown", typeof b.totals.estimated_api_usd === "number" ? "$" + metric(b.totals.estimated_api_usd, 6) : "Unknown"],
  ];
  return '<div class="table-scroll" tabindex="0" role="region" aria-label="Pair measurements"><table><thead><tr><th>Measurement</th><th class="a">A: ' + esc(labels.stock || "Stock") + '</th><th class="b">B: ' + esc(labels.current || "Current") + "</th></tr></thead><tbody>"
    + rows.map(([label, av, bv]) => "<tr><th>" + esc(label) + '</th><td class="metric a">' + esc(av) + '</td><td class="metric b">' + esc(bv) + "</td></tr>").join("") + "</tbody></table></div>";
}
function criterionTable(report) {
  const contract = obj(obj(report.criteria).contract);
  const criteria = Array.isArray(contract.criteria) ? contract.criteria : [];
  if (!criteria.length) return "";
  const evidence = (arm, id) => {
    const grade = obj(obj(obj(report.arms)[arm]).result).grade;
    const matches = Object.values(obj(obj(grade).semantic)).flat().filter((item) => obj(item).criterion === id);
    return matches.length ? matches.map((item) => '<details><summary>' + esc(words(item.status)) + " · " + esc(item.basis) + "</summary><p>" + esc(item.reasoning) + '</p><div class="tree">' + tree(item.execution ?? item.check) + "</div></details>").join("") : '<span class="hint">Not assessed</span>';
  };
  return '<h3>Criterion outcomes</h3><div class="table-scroll" tabindex="0" role="region" aria-label="Criterion outcomes"><table><thead><tr><th>Criterion</th><th class="a">A evidence</th><th class="b">B evidence</th></tr></thead><tbody>'
    + criteria.map((item) => "<tr><th>" + esc(item.id) + '<p class="hint">' + esc(item.description) + '</p></th><td class="a">' + evidence("stock", item.id) + '</td><td class="b">' + evidence("current", item.id) + "</td></tr>").join("") + "</tbody></table></div>";
}
function judgeSummary(judge) {
  const result = obj(obj(judge).result);
  if (!Array.isArray(result.passes) || !result.passes.length) return "";
  return '<h3>Source assessment</h3>' + result.passes.map((pass) => '<details class="tree"><summary>Pass ' + esc(pass.pass) + ": " + esc(pass.winner) + "</summary><p>" + esc(pass.rationale) + "</p>"
    + (Array.isArray(pass.evidence) ? "<ul>" + pass.evidence.map((item) => "<li>" + esc(item) + "</li>").join("") + "</ul>" : "")
    + "<div>" + tree({ presentation: pass.presentation, scores: pass.scores, issues: pass.issues, criteria: pass.criteria }) + "</div></details>").join("");
}
function resultContent(data) {
  const state = obj(data.state), report = obj(data.report);
  const labels = { ...obj(data.arm_labels), ...obj(report.arm_labels) };
  const currentInvalidity = Array.isArray(state.invalidity_reasons) ? state.invalidity_reasons : [];
  const invalidated = currentInvalidity.length > 0;
  const invalidationNotice = invalidated ? '<div class="notice error"><strong>Interpretation invalidated</strong><p>' + esc(currentInvalidity.join("\n")) + "</p><p>Regenerate the report to update exported evidence. Recorded measurements remain available below.</p></div>" : "";
  if (data.entry.kind === "build") return "<h2>Captured build</h2><p class='hint'>Build identity is available when capture succeeds. Failed builds retain their available logs.</p>" + disclosure("Build identity and retained outcome", state);
  if (!Object.keys(report).length) return "<h2>Partial results</h2>" + invalidationNotice + "<p class='hint'>The report appears when the CLI generates it. Collected grades remain visible while work continues.</p>" + (data.entry.kind === "pair" ? metricTable({}, state, labels) : "");
  if (data.entry.kind === "pair") {
    const warnings = [...new Set([...currentInvalidity, ...(report.invalidity_reasons || []), ...Object.values(obj(report.arms)).flatMap((arm) => obj(arm.usage).warnings || [])])];
    const complete = report.measurement_complete === true && !invalidated;
    return "<h2>Comparison results</h2><p class='hint'>" + esc(report.design || "Descriptive paired evidence") + "</p>"
      + (invalidated ? invalidationNotice : '<div class="result-summary' + (complete ? "" : " warn") + '"><strong>' + (complete ? "Measurement complete" : "Measurement incomplete") + "</strong><p>" + esc(report.winner_reason || report.comparison_exclusion || "Interpret the available evidence with its validity gates.") + "</p>"
      + (report.winner ? "<p>Recorded outcome: " + esc(report.winner) + "</p>" : "") + "</div>")
      + metricTable(report, state, labels)
      + (warnings.length ? '<ul class="warning-list">' + warnings.map((warning) => "<li>" + esc(warning) + "</li>").join("") + "</ul>" : "")
      + criterionTable(report) + judgeSummary(report.judge)
      + disclosure("Criterion evidence and grading", { contract: report.criteria, candidates: Object.fromEntries(Object.entries(obj(report.arms)).map(([name, arm]) => [name, obj(obj(arm).result).grade])) })
      + disclosure("Source assessments and judge reasoning", report.judge)
      + disclosure("Time, token and cost differences", { current_minus_stock_percent: report.current_minus_stock_percent, efficiency: report.efficiency, performance_breakdown: report.performance_breakdown })
      + disclosure("Usage details and pricing provenance", { arms: Object.fromEntries(Object.entries(obj(report.arms)).map(([name, arm]) => [name, obj(arm).usage])), pricing: report.pricing })
      + disclosure("Diagnostics and workflow evidence", { mekugi: report.mekugi_diagnostics_by_arm ?? report.mekugi_diagnostics, workflow: report.workflow_mechanisms })
      + disclosure(invalidated ? "Retained report, regenerate after invalidation" : "Complete structured report", report);
  }
  if (data.entry.kind === "trials") {
    const rows = Object.entries(obj(report.current_minus_stock)).map(([name, value]) => {
      const stats = obj(value);
      return "<tr><th>" + esc(words(name)) + "</th><td>" + metric(obj(stats.stock).mean, 3) + "</td><td>" + metric(obj(stats.current).mean, 3) + "</td><td>" + metric(obj(stats.difference).mean, 3) + "</td><td>" + metric(obj(stats.percent).mean, 2) + "</td><td>" + metric(obj(stats.difference).n) + "</td></tr>";
    }).join("");
    return "<h2>Trial-set results</h2><p>" + metric(report.eligible_pairs) + " eligible pairs of " + metric(report.planned_pairs) + " planned. Differences are B minus A.</p><p class='hint'>Unavailable metrics are excluded. These observations do not establish causality.</p>"
      + '<div class="table-scroll" tabindex="0" role="region" aria-label="Trial statistics"><table><thead><tr><th>Metric</th><th>A mean</th><th>B mean</th><th>Difference mean</th><th>Percent mean</th><th>Pairs</th></tr></thead><tbody>' + rows + "</tbody></table></div>"
      + disclosure("Distributions, medians and sample variation", report.current_minus_stock)
      + disclosure("Pair eligibility, results and source assessments", report.pairs)
      + disclosure("Complete trial report", report);
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
  const targetKeys = new Set(["run-dir", "trial-set", "suite-run"]);
  const fields = config.commands[command].filter((key) => !targetKeys.has(key));
  const labels = { arm: "Selected arm (optional)", "control-run": "Completed stock control directory (optional)", "control-bundle-sha256": "Control bundle SHA-256 (optional)", "recover-judge": "Recover eligible failed judge stages", "source-assessments": "Supplied source-assessment JSON (optional)", exclusions: "Usage exclusions JSON file", reason: "Invalidation reason", "output-dir": "Report output directory (optional)", count: "Fresh pair count", order: "Trial arm order", "auth-file": "Codex authentication file", "grok-auth-file": "Grok authentication file", "docker-bin": "Docker executable", "output-parent": "Output parent (optional)" };
  $("action-options").innerHTML = fields.map((key) => {
    if (key === "confirm-paid-inference") return check("I authorize paid inference for this action", key, "a");
    if (["recover-judge", "protect-mekugi"].includes(key)) return check(labels[key] || words(key), key, "a");
    if (key === "arm") return select(labels[key], key, [["", "Both arms"], ["stock", "A only"], ["current", "B only"]], "", "", "a");
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
function readableLog(text) {
  return String(text).split("\n").map((line) => {
    try {
      const value = JSON.parse(line);
      const item = obj(value.item);
      return (value.type || "event") + (item.text ? ": " + item.text : ": " + line);
    } catch { return line; }
  }).join("\n");
}
function renderSnapshot(data) {
  snapshot = data;
  const entry = data.entry, state = obj(data.state), job = obj(entry.job);
  $("run-title").textContent = entry.title;
  $("run-directory").textContent = entry.directory || "Preparing the local environment; the evidence directory will appear here.";
  $("stop-operation").hidden = activeId !== entry.id;
  $("stop-operation").disabled = job.status === "stopping";
  $("stop-operation").textContent = job.status === "stopping" ? "Stopping and retaining evidence…" : "Stop operation";
  const statuses = obj(state.arm_attempts);
  const errors = [job.error, state.error, obj(state.finishing).error, obj(state.judge).error].filter(Boolean);
  const phaseItems = entry.kind === "pair" ? [
    ["A execution", obj(statuses.stock).status || "Not started"],
    ["B execution", obj(statuses.current).status || "Not started"],
    ["Source assessment", obj(state.judge).status || "Not started"],
    ["Report finishing", obj(state.finishing).status || (data.report ? "Report available" : "Not started")],
  ] : [["Evidence", state.status || "Preparing"], ["Operation", job.status || "Attached"], ["Completed children", data.children.filter((child) => child.status === "complete").length + " of " + data.children.length], ["Report", data.report ? "Available" : "Not yet generated"]];
  $("run-status").innerHTML = '<div class="status-line"><span class="badge ' + esc(job.status || state.status || "prepared") + '">' + esc(job.status || "attached") + "</span><span>Evidence: " + esc(state.status || "not yet prepared") + '</span><span>Operation elapsed: <span id="operation-elapsed"></span></span></div>'
    + '<div class="phases">' + phaseItems.map(([title, value]) => "<div><strong>" + esc(title) + "</strong><span>" + esc(value) + "</span></div>").join("") + "</div>"
    + (errors.length ? '<p class="notice error">' + esc([...new Set(errors)].join("\n")) + "</p>" : "");
  renderElapsed();
  const log = $("phase-log");
  const atBottom = log.scrollHeight - log.clientHeight - log.scrollTop < 40;
  log.textContent = job.log || "No phase messages from this server operation. Attached runs expose persisted state and candidate logs below.";
  if ($("follow-log").checked && atBottom) log.scrollTop = log.scrollHeight;
  const live = Object.entries(obj(data.live)).filter(([, text]) => text);
  const keys = live.map(([arm]) => arm).join(",");
  if (liveKeys !== keys) {
    $("live-output").innerHTML = live.map(([arm]) => '<details class="panel"><summary>' + esc(arm.startsWith("build") ? words(arm) + " output" : arm === "stock" ? "A candidate output" : "B candidate output") + '</summary><pre class="log" data-live="' + esc(arm) + '"></pre></details>').join("");
    liveKeys = keys;
  }
  for (const [arm, text] of live) {
    const element = $("live-output").querySelector('[data-live="' + arm + '"]');
    const wasAtBottom = element.scrollHeight - element.clientHeight - element.scrollTop < 40;
    element.textContent = readableLog(text);
    if ($("follow-log").checked && wasAtBottom) element.scrollTop = element.scrollHeight;
  }
  if (childSignature !== JSON.stringify(data.children)) {
    $("children").innerHTML = data.children.map((child) => '<button data-entry="' + child.id + '"><strong>' + esc(child.title) + "</strong> · " + esc(child.status || "preparing") + (child.error ? '<span class="error"> ' + esc(child.error) + "</span>" : "") + "</button>").join("");
    childSignature = JSON.stringify(data.children);
  }
  const signature = JSON.stringify([data.report, data.arm_labels, entry.kind === "build" ? state : state.results, state.invalidity_reasons]);
  if (reportSignature !== signature) {
    const opened = [...$("results").querySelectorAll("details[open]")].map((element) => element.querySelector("summary").textContent);
    $("results").innerHTML = resultContent(data);
    for (const detail of $("results").querySelectorAll("details")) if (opened.includes(detail.querySelector("summary").textContent)) detail.open = true;
    reportSignature = signature;
  }
  if (stateSignature !== JSON.stringify(state)) {
    $("state-details").innerHTML = '<div class="tree">' + tree(state) + "</div>"; stateSignature = JSON.stringify(state);
  }
  artifactItems = data.artifacts; renderArtifacts();
  if (actionEntry !== entry.id + entry.kind + Boolean(entry.directory)) {
    actionFields(entry); actionEntry = entry.id + entry.kind + Boolean(entry.directory);
  }
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
  stream.addEventListener("snapshot", (event) => {
    if (!current()) return;
    const data = JSON.parse(event.data);
    latestSnapshot = data;
    $("watch-error").textContent = "";
    if ($("watch-enabled").checked || !snapshot || data.entry.job?.status !== snapshot.entry.job?.status) renderSnapshot(data);
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
