type Event = Record<string, unknown>;
const object = (value: unknown): Event => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Event : {};

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
    const item = object(event.item);
    const key = typeof item.id === "string" ? item.id : `event-${index}`;
    if (typeof event.type === "string" && ["item.started", "item.updated", "item.completed"].includes(event.type)) {
      if ((item.type === "agent_message" || item.type === "reasoning") && typeof item.text === "string") {
        messages.set(key, `<article class="output-message">${markdown(item.text)}</article>`);
      } else if (item.type === "command_execution" || item.type === "mcp_tool_call" || item.type === "file_change" || item.type === "web_search") {
        const label = { command_execution: "Command", mcp_tool_call: "Tool call", file_change: "File changes", web_search: "Web search" }[item.type];
        const failed = item.status === "failed" || (typeof item.exit_code === "number" && item.exit_code !== 0);
        const status = failed ? "failed" : event.type === "item.completed" ? "completed" : "in progress";
        messages.set(key, `<p class="output-activity">${label} ${status}${typeof item.exit_code === "number" ? ` (exit ${item.exit_code})` : ""}</p>`);
      }
    } else if (event.type === "error" || event.type === "turn.failed") {
      const message = event.message ?? object(event.error).message;
      messages.set(key, `<p class="notice error">${Bun.escapeHTML(typeof message === "string" ? message : "Execution failed. Open the raw log for details.")}</p>`);
    }
  }
  return [...messages.values()].join("") || '<p class="hint">No readable messages in the current log excerpt. Raw events are available in the evidence files.</p>';
}
