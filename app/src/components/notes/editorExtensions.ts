import { Decoration, DecorationSet, EditorView, MatchDecorator, ViewPlugin, ViewUpdate } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { CompletionContext } from '@codemirror/autocomplete';
import { tags as t } from '@lezer/highlight';

export const WIKI_RE = /\[\[([^\]\n]+)\]\]/g;

const FONT_SANS = "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
const FONT_MONO = "ui-monospace, SFMono-Regular, 'JetBrains Mono', Menlo, Consolas, monospace";

export const noteTheme = EditorView.theme(
  {
    '&': { color: '#e4e4e7', backgroundColor: 'transparent', fontSize: '16px', height: '100%' },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': { fontFamily: FONT_SANS, lineHeight: '1.7', overflow: 'auto' },
    '.cm-content': { caretColor: '#818cf8', padding: '8px 0 160px', maxWidth: '720px', margin: '0 auto' },
    '.cm-line': { padding: '0 24px' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: '#818cf8', borderLeftWidth: '2px' },
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection':
      { backgroundColor: 'rgba(99,102,241,0.28)' },
    '.cm-activeLine': { backgroundColor: 'transparent' },
    '.cm-gutters': { display: 'none' },
    '.cm-tooltip': {
      backgroundColor: '#18181b',
      border: '1px solid #3f3f46',
      borderRadius: '8px',
      boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
      overflow: 'hidden',
      fontFamily: FONT_SANS,
    },
    '.cm-tooltip-autocomplete > ul': { fontFamily: FONT_SANS, maxHeight: '220px' },
    '.cm-tooltip-autocomplete > ul > li': { padding: '4px 12px', color: '#d4d4d8' },
    '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'rgba(99,102,241,0.25)', color: '#fff' },
    '.cm-completionIcon': { display: 'none' },
  },
  { dark: true }
);

const highlight = HighlightStyle.define([
  { tag: t.heading1, fontSize: '1.75em', fontWeight: '700', color: '#fafafa', lineHeight: '1.3' },
  { tag: t.heading2, fontSize: '1.4em', fontWeight: '650', color: '#f4f4f5', lineHeight: '1.35' },
  { tag: t.heading3, fontSize: '1.2em', fontWeight: '600', color: '#f4f4f5' },
  { tag: [t.heading4, t.heading5, t.heading6], fontWeight: '600', color: '#e4e4e7' },
  { tag: t.strong, fontWeight: '700', color: '#fafafa' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through', color: '#71717a' },
  { tag: t.processingInstruction, color: '#52525b', fontWeight: '400' },
  { tag: t.link, color: '#a5b4fc' },
  { tag: t.url, color: '#818cf8' },
  { tag: t.quote, color: '#a1a1aa', fontStyle: 'italic' },
  { tag: t.monospace, fontFamily: FONT_MONO, fontSize: '0.9em', color: '#c7d2fe', backgroundColor: 'rgba(63,63,70,0.45)', borderRadius: '4px' },
  { tag: t.contentSeparator, color: '#52525b' },
  { tag: t.meta, color: '#52525b' },
]);
export const noteHighlight = syntaxHighlighting(highlight);

const wikiMatcher = new MatchDecorator({ regexp: WIKI_RE, decoration: Decoration.mark({ class: 'cm-wikilink' }) });
const tagMatcher = new MatchDecorator({
  regexp: /(?<=^|\s)#[\w-]+/g,
  decoration: Decoration.mark({ class: 'cm-hashtag' }),
});
const taskMatcher = new MatchDecorator({
  regexp: /^\s*[-*+] \[( |x|X)\] /g,
  decoration: (m) => Decoration.mark({ class: m[1] === ' ' ? 'cm-task cm-task-open' : 'cm-task cm-task-done' }),
});

function matcherPlugin(m: MatchDecorator) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = m.createDeco(view);
      }
      update(u: ViewUpdate) {
        this.decorations = m.updateDeco(u, this.decorations);
      }
    },
    { decorations: (v) => v.decorations }
  );
}

const quoteLine = Decoration.line({ class: 'cm-quote-line' });
const listLine = Decoration.line({ class: 'cm-list-line' });
const lineClassPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged) this.decorations = this.build(u.view);
    }
    build(view: EditorView) {
      const ranges = [];
      for (const { from, to } of view.visibleRanges) {
        for (let pos = from; pos <= to; ) {
          const line = view.state.doc.lineAt(pos);
          if (/^\s*>/.test(line.text)) ranges.push(quoteLine.range(line.from));
          else if (/^\s*([-*+]|\d+[.)]) /.test(line.text)) ranges.push(listLine.range(line.from));
          pos = line.to + 1;
        }
      }
      return Decoration.set(ranges);
    }
  },
  { decorations: (v) => v.decorations }
);

export const decorationExtensions = [matcherPlugin(wikiMatcher), matcherPlugin(tagMatcher), matcherPlugin(taskMatcher), lineClassPlugin];

// Ctrl/Cmd+click on a link follows it (plain click keeps the caret in place for editing).
export function wikiClickExtension(onFollow: (target: string) => void) {
  return EditorView.domEventHandlers({
    mousedown(e, view) {
      if (!(e.metaKey || e.ctrlKey)) return false;
      const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
      if (pos == null) return false;
      const line = view.state.doc.lineAt(pos);
      const re = new RegExp(WIKI_RE.source, 'g');
      let m: RegExpExecArray | null;
      while ((m = re.exec(line.text))) {
        const start = line.from + m.index;
        if (pos >= start && pos <= start + m[0].length) {
          e.preventDefault();
          onFollow(m[1].trim());
          return true;
        }
      }
      return false;
    },
  });
}

// Typing [[ suggests existing note titles.
export function wikiCompletion(getTitles: () => string[]) {
  return (ctx: CompletionContext) => {
    const m = ctx.matchBefore(/\[\[[^\]\n]*/);
    if (!m) return null;
    return {
      from: m.from + 2,
      filter: true,
      options: getTitles().map((title) => ({
        label: title,
        apply: (view: EditorView, _c: unknown, from: number, to: number) => {
          const after = view.state.doc.sliceString(to, to + 2);
          const insert = after === ']]' ? title : `${title}]]`;
          view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + title.length + 2 } });
        },
      })),
    };
  };
}
