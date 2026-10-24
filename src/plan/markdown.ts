// A deliberately small markdown-to-HTML converter for the WordPress export. It supports what a post
// needs (headings, paragraphs, bullet and numbered lists, bold, italic, links) and nothing else. Every
// character of the source is HTML-escaped first, so raw HTML, scripts and event handlers in a draft can
// never reach the page; links are made only from http and https addresses.

const escapeHtml = (text: string): string => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

function safeUrl(raw: string): string | null {
  const decoded = raw.replaceAll("&amp;", "&");
  if (/["<>\s]/.test(decoded)) return null;
  try {
    const url = new URL(decoded);
    return url.protocol === "http:" || url.protocol === "https:" ? decoded : null;
  } catch {
    return null;
  }
}

/** Bold, italic and links inside one line of already-escaped text. */
function inline(escaped: string): string {
  const withLinks = escaped.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label: string, address: string) => {
    const url = safeUrl(address);
    // the address was escaped with the rest of the line, so it is already safe inside the attribute
    return url === null ? label : `<a href="${address}">${label}</a>`;
  });
  return withLinks.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/(^|[^*])\*([^*\s][^*]*)\*(?!\*)/g, "$1<em>$2</em>");
}

export function markdownToHtml(source: string): string {
  const lines = source.replaceAll("\r\n", "\n").split("\n");
  const out: string[] = [];
  let paragraph: string[] = [];
  let list: { tag: "ul" | "ol"; items: string[] } | null = null;

  const flushParagraph = () => {
    if (paragraph.length > 0) out.push(`<p>${inline(paragraph.map(escapeHtml).join(" "))}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(escapeHtml(i))}</li>`).join("")}</${list.tag}>`);
    list = null;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    const bullet = /^[-*]\s+(.+)$/.exec(line);
    const numbered = /^\d+[.)]\s+(.+)$/.exec(line);
    if (line.trim() === "") {
      flushParagraph();
      flushList();
    } else if (heading) {
      flushParagraph();
      flushList();
      out.push(`<h${(heading[1] as string).length}>${inline(escapeHtml(heading[2] as string))}</h${(heading[1] as string).length}>`);
    } else if (bullet || numbered) {
      flushParagraph();
      const tag = bullet ? "ul" : "ol";
      if (list && list.tag !== tag) flushList();
      list = list ?? { tag, items: [] };
      list.items.push(((bullet ?? numbered) as RegExpExecArray)[1] as string);
    } else {
      flushList();
      paragraph.push(line.trim());
    }
  }
  flushParagraph();
  flushList();
  return out.join("\n");
}
