type Event = Record<string, unknown>;
const object = (value: unknown): Event => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Event : {};
const headlessItemTypes: Record<string, string> = {
  agentMessage: "agent_message", commandExecution: "command_execution", mcpToolCall: "mcp_tool_call",
  fileChange: "file_change", webSearch: "web_search",
};

function markdown(text: string): string {
  return Bun.markdown.render(text, {
    text: Bun.escapeHTML,
    html: Bun.escapeHTML,
    heading: (children, { level }) => `<h${level}>${children}</h${level}>`,
    paragraph: children => `<p>${children}</p>`,
    strong: children => `<strong>${children}</strong>`,
    emphasis: children => `<em>${children}</em>`,
    strikethrough: children => `<del>${children}</del>`,
    codespan: children => `<code>${children}</code>`,
    code: children => `<pre><code>${children}</code></pre>`,
    blockquote: children => `<blockquote>${children}</blockquote>`,
    list: (children, { ordered, start }) => ordered ? `<ol start="${start ?? 1}">${children}</ol>` : `<ul>${children}</ul>`,
    listItem: (children, { checked }) => `<li>${checked === undefined ? "" : checked ? "[Done] " : "[Pending] "}${children}</li>`,
    hr: () => "<hr>",
    table: children => `<div class="table-scroll"><table>${children}</table></div>`,
    thead: children => `<thead>${children}</thead>`,
    tbody: children => `<tbody>${children}</tbody>`,
    tr: children => `<tr>${children}</tr>`,
    th: children => `<th>${children}</th>`,
    td: children => `<td>${children}</td>`,
    image: children => children,
    link: (children, { href }) => {
      try {
        const url = new URL(href);
        if (["https:", "http:", "mailto:"].includes(url.protocol)) return `<a href="${Bun.escapeHTML(url.href)}" target="_blank" rel="noopener noreferrer">${children}</a>`;
      } catch { /* Workspace paths are evidence references, not workbench routes. */ }
      return `<span title="${Bun.escapeHTML(href)}">${children}</span>`;
    },
  }, { noHtmlBlocks: true, noHtmlSpans: true });
}

export function renderSetupOutput(text: string): string {
  const messages = new Map<string, string>();
  for (const [index, line] of text.split("\n").entries()) {
    let event: Event;
    try { event = object(JSON.parse(line)); }
    catch { continue; } // A bounded tail or a live write can contain an incomplete record.
    const headless = typeof event.method === "string";
    const payload = headless ? object(event.params) : event;
    const item = object(payload.item);
    const type = event.method === "item/started" ? "item.started" : event.method === "item/completed" ? "item.completed"
      : event.method === "error" ? "error" : event.type;
    const itemType = headless && typeof item.type === "string" ? headlessItemTypes[item.type] ?? item.type : item.type;
    const exitCode = headless ? item.exitCode : item.exit_code;
    const key = typeof item.id === "string" ? item.id : `event-${index}`;
    if (typeof type === "string" && ["item.started", "item.updated", "item.completed"].includes(type)) {
      if ((itemType === "agent_message" || itemType === "reasoning") && typeof item.text === "string") {
        messages.set(key, `<article class="output-message">${markdown(item.text)}</article>`);
      } else if (itemType === "command_execution" || itemType === "mcp_tool_call" || itemType === "file_change" || itemType === "web_search") {
        const label = { command_execution: "Command", mcp_tool_call: "Tool call", file_change: "File changes", web_search: "Web search" }[itemType];
        const failed = item.status === "failed" || (typeof exitCode === "number" && exitCode !== 0);
        const status = failed ? "failed" : type === "item.completed" ? "completed" : "in progress";
        messages.set(key, `<p class="output-activity">${label} ${status}${typeof exitCode === "number" ? ` (exit ${exitCode})` : ""}</p>`);
      }
    } else if (type === "error" || type === "turn.failed") {
      const message = payload.message ?? object(payload.error).message;
      messages.set(key, `<p class="notice error">${Bun.escapeHTML(typeof message === "string" ? message : "Execution failed. Open the raw log for details.")}</p>`);
    }
  }
  return [...messages.values()].join("") || '<p class="hint">No readable messages in the current log excerpt. Raw events are available in the evidence files.</p>';
}
