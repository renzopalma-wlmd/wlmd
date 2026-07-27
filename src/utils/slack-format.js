// ==========================================================
// Slack mrkdwn helpers
//
// Gemini emits GitHub-flavored Markdown no matter how firmly the system
// prompt asks for Slack formatting, so the model output is normalized here
// instead of being trusted. Slack's mrkdwn is NOT Markdown: bold is *one*
// asterisk, `**bold**` renders literally, and `-`/`*` list syntax is not
// supported at all.
// ==========================================================

/**
 * Convert GitHub-flavored Markdown to Slack mrkdwn.
 * Content inside fenced code blocks is left untouched.
 * @param {string} text
 * @returns {string}
 */
function toMrkdwn(text) {
  if (!text) return '';

  // Odd indexes are the ``` fences themselves — never rewrite code.
  return text
    .split(/(```[\s\S]*?```)/g)
    .map((chunk, i) => (i % 2 === 1 ? chunk : convertSegment(chunk)))
    .join('')
    .trim();
}

function convertSegment(segment) {
  return (
    segment
      // Headings have no mrkdwn equivalent — render them as a bold line.
      // Only horizontal whitespace ([ \t], never \s) may be matched around
      // line-anchored patterns: \s includes \n, which lets a match reach back
      // into the previous blank line and silently delete paragraph breaks.
      .replace(/^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t]*#*$/gm, '*$1*')
      // **bold** / __bold__ -> *bold*
      .replace(/\*\*(?=\S)([^\n*]+?)(?<=\S)\*\*/g, '*$1*')
      .replace(/__(?=\S)([^\n_]+?)(?<=\S)__/g, '*$1*')
      // Horizontal rules are pure noise in a chat message.
      .replace(/^[ \t]*([-*_])\1{2,}[ \t]*$/gm, '')
      // Markdown list markers -> real bullets (indentation preserved).
      .replace(/^([ \t]*)[-*+][ \t]+/gm, '$1• ')
      // [text](url) -> <url|text>
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<$2|$1>')
      .replace(/\n{3,}/g, '\n\n')
  );
}

/**
 * Render a Slack channel reference. Slack expands this to the channel's real
 * name client-side, which avoids needing the `channels:read` scope just to
 * turn an ID into something a human can read.
 * @param {string} channelId
 * @returns {string|null}
 */
function channelRef(channelId) {
  return /^[CGD][A-Z0-9]+$/.test(channelId || '') ? `<#${channelId}>` : null;
}

/**
 * Render a Slack message timestamp as a localized date token. Slack renders
 * this in each reader's own timezone; the text after `|` is the fallback.
 * @param {string|number} ts - Slack ts ("1784950401.358739") or epoch seconds
 * @param {string} [token='{date_short_pretty} {time}']
 * @returns {string|null}
 */
function dateRef(ts, token = '{date_short_pretty} {time}') {
  const epoch = Math.floor(Number.parseFloat(ts));
  if (!Number.isFinite(epoch) || epoch <= 0) return null;

  const fallback = new Date(epoch * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  return `<!date^${epoch}^${token}|${fallback}>`;
}

/**
 * Best-effort epoch seconds for a knowledge_context row. Slack rows carry the
 * true message time in metadata.ts; everything else falls back to the row's
 * insertion time.
 * @param {Object} row
 * @returns {number|null}
 */
function rowEpoch(row) {
  const ts = row?.metadata?.ts;
  const fromMeta = Math.floor(Number.parseFloat(ts));
  if (Number.isFinite(fromMeta) && fromMeta > 0) return fromMeta;

  if (row?.created_at) {
    const fromRow = Math.floor(new Date(row.created_at).getTime() / 1000);
    if (Number.isFinite(fromRow) && fromRow > 0) return fromRow;
  }
  return null;
}

/**
 * Bound a message body so a long enumeration can't hit Slack's message limits
 * or bury the reader. Cuts on a line or word boundary, never mid-token — a
 * truncated `<!date^...>` or `<#C...>` would render as broken literal text.
 * @param {string} text
 * @param {number} [max=3800]
 * @returns {string}
 */
function truncateForSlack(text, max = 3800) {
  if (!text || text.length <= max) return text;

  const head = text.slice(0, max);
  // Prefer a line break so a bulleted list ends on a whole bullet; fall back to
  // a word boundary only if the last break is too far back to be useful.
  const newline = head.lastIndexOf('\n');
  const space = head.lastIndexOf(' ');
  const floor = max * 0.6;
  const cut = newline > floor ? newline : space > floor ? space : -1;
  const safe = (cut > 0 ? head.slice(0, cut) : head).trimEnd();

  return `${safe}\n\n_…truncated — ask a narrower question for the full detail._`;
}

module.exports = { toMrkdwn, channelRef, dateRef, rowEpoch, truncateForSlack };
