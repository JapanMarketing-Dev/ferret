/**
 * Word（本文の w:p・w:t）と PowerPoint（スライドの a:p・a:t）の文字を、段落ごとに読み書きする（純粋な関数）。
 *
 * XML を木に組み直さず、元の文字列のうち文字の部分だけを差し替える（書式・画像・ほかの要素は1文字も変えない）。
 * 段落の文字を直したら、元と新しい文字の前後の一致を除いた「変わった所」だけを、その位置にある文字の要素（run）へ入れる。
 * 書式の違う run が並んでいても、触っていない部分の書式はそのまま残る。
 * 改行（w:br・a:br）とタブ（w:tab）は段落の中の区切りとして扱い、並びが変わったときだけ段落の文字を作り直す
 * （このときは最初の run の書式にそろう）。
 */

export type TextDialect = 'w' | 'a'

const NAMESPACES: Record<TextDialect, string> = {
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main'
}
const MC_NAMESPACE = 'http://schemas.openxmlformats.org/markup-compatibility/2006'

/** 段落の中の1つの部品。text は文字の要素（w:t・a:t）、sep は改行・タブ */
type Atom =
  | {
      kind: 'text'
      /** 開始タグ（`<w:t ...>`）の位置 */
      tagStart: number
      tagEnd: number
      /** 中身（開始タグと終了タグの間）。自己終了（`<w:t/>`）なら tagEnd と同じ */
      contentStart: number
      contentEnd: number
      selfClosing: boolean
      text: string
      /** 入っている run（w:r・a:r・a:fld）の開始タグと、run の開始タグの後ろから文字の要素までの元の文字列（a:rPr など） */
      runTag: string
      runQName: string
      beforeText: string
    }
  | { kind: 'sep'; char: '\n' | '\t'; start: number; end: number }

interface ParagraphScan {
  atoms: Atom[]
  /** 段落の開始タグ */
  openStart: number
  openEnd: number
  selfClosing: boolean
  /** 終了タグの位置（自己終了なら openEnd） */
  closeStart: number
  /** a:endParaRPr の元の文字列と位置（PowerPoint の空の段落へ文字を足すときに使う） */
  endParaRPr?: { start: number; end: number; raw: string }
  /** 入れ物（スライドのテキストボックス・表のセル）を見分ける番号。同じ入れ物の段落は同じ値 */
  group: number
}

export interface TextParagraph {
  text: string
  /** 同じテキストボックス・表のセルなら同じ値（画面で段落をまとめる） */
  group: number
}

function prefixOf(xml: string, uri: string): string | null {
  const re = /xmlns(?::([\w.-]+))?\s*=\s*(?:"([^"]*)"|'([^']*)')/g
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    if ((m[2] ?? m[3]) === uri) return m[1] ?? ''
  }
  return null
}

function qualify(prefix: string, local: string): string {
  return prefix ? `${prefix}:${local}` : local
}

/** タグの終わりの `>`（引用符の中の `>` は飛ばす） */
function tagEnd(source: string, from: number): number {
  let quote = ''
  for (let i = from; i < source.length; i += 1) {
    const c = source[i]
    if (quote) {
      if (c === quote) quote = ''
    } else if (c === '"' || c === "'") quote = c
    else if (c === '>') return i
  }
  return -1
}

const XML_ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }

function decodeText(raw: string): string {
  // CDATA はそのまま、ほかは実体を戻す
  let out = ''
  let i = 0
  while (i < raw.length) {
    const cdata = raw.indexOf('<![CDATA[', i)
    const end = cdata === -1 ? raw.length : cdata
    out += raw.slice(i, end).replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, body: string) => {
      if (body[0] === '#') {
        const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
      }
      return XML_ENTITIES[body] ?? whole
    })
    if (cdata === -1) break
    const close = raw.indexOf(']]>', cdata + 9)
    if (close === -1) {
      out += raw.slice(cdata + 9)
      break
    }
    out += raw.slice(cdata + 9, close)
    i = close + 3
  }
  return out
}

/** XML の文字に入れられない制御文字を落とし、& < > を逃がす */
export function escapeXmlText(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

interface Frame {
  qname: string
  start: number
  openEnd: number
  paragraph?: ParagraphScan
}

/** 段落と、その中の文字の要素・区切りを読む。段落は開始タグの順（入れ子の段落は外の段落の後ろ） */
function scan(xml: string, dialect: TextDialect): ParagraphScan[] {
  const prefix = prefixOf(xml, NAMESPACES[dialect])
  if (prefix === null) return []
  const mc = prefixOf(xml, MC_NAMESPACE)
  const P = qualify(prefix, 'p')
  const T = qualify(prefix, 't')
  const runNames = new Set([qualify(prefix, 'r'), ...(dialect === 'a' ? [qualify(prefix, 'fld')] : [])])
  const BR = qualify(prefix, 'br')
  const CR = qualify(prefix, 'cr')
  const TAB = qualify(prefix, 'tab')
  const END_PARA = qualify(prefix, 'endParaRPr')
  const FALLBACK = mc === null ? null : qualify(mc, 'Fallback')
  const groupNames = new Set(dialect === 'a' ? ['txBody'] : ['tc', 'txbxContent'])

  const paragraphs: ParagraphScan[] = []
  const stack: Frame[] = []
  let fallbackDepth = 0
  const groupIds = new Map<number, number>()
  let i = 0
  const nearestParagraph = (): { frame: Frame; index: number } | null => {
    for (let k = stack.length - 1; k >= 0; k -= 1) if (stack[k]!.paragraph) return { frame: stack[k]!, index: k }
    return null
  }
  const runAbove = (paraIndex: number): Frame | null => {
    for (let k = stack.length - 1; k > paraIndex; k -= 1) if (runNames.has(stack[k]!.qname)) return stack[k]!
    return null
  }
  const groupOf = (): number => {
    for (let k = stack.length - 1; k >= 0; k -= 1) {
      const name = stack[k]!.qname
      const local = name.slice(name.indexOf(':') + 1)
      if (groupNames.has(local)) {
        const start = stack[k]!.start
        if (!groupIds.has(start)) groupIds.set(start, groupIds.size)
        return groupIds.get(start)!
      }
    }
    return -1
  }

  while (i < xml.length) {
    const lt = xml.indexOf('<', i)
    if (lt === -1) break
    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4)
      i = end === -1 ? xml.length : end + 3
      continue
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9)
      i = end === -1 ? xml.length : end + 3
      continue
    }
    if (xml.startsWith('<?', lt) || xml.startsWith('<!', lt)) {
      const end = tagEnd(xml, lt + 2)
      i = end === -1 ? xml.length : end + 1
      continue
    }
    const gt = tagEnd(xml, lt + 1)
    if (gt === -1) break
    const closing = xml[lt + 1] === '/'
    const selfClosing = !closing && xml[gt - 1] === '/'
    const nameMatch = /^[^\s/>]+/.exec(xml.slice(lt + (closing ? 2 : 1), gt))
    const qname = nameMatch ? nameMatch[0] : ''
    i = gt + 1
    if (closing) {
      // 対応する開始タグまで閉じる（壊れた入れ子でも止まらない）
      for (let k = stack.length - 1; k >= 0; k -= 1) {
        if (stack[k]!.qname !== qname) continue
        const closed = stack.splice(k)
        for (const frame of closed) {
          if (frame.qname === FALLBACK) fallbackDepth -= 1
          if (frame.paragraph) frame.paragraph.closeStart = lt
        }
        break
      }
      continue
    }
    if (fallbackDepth > 0) {
      if (!selfClosing) {
        stack.push({ qname, start: lt, openEnd: gt + 1 })
        if (qname === FALLBACK) fallbackDepth += 1
      }
      continue
    }
    if (qname === P) {
      const paragraph: ParagraphScan = { atoms: [], openStart: lt, openEnd: gt + 1, selfClosing, closeStart: gt + 1, group: groupOf() }
      paragraphs.push(paragraph)
      if (!selfClosing) stack.push({ qname, start: lt, openEnd: gt + 1, paragraph })
      continue
    }
    const para = nearestParagraph()
    if (para) {
      const run = runAbove(para.index)
      const atoms = para.frame.paragraph!.atoms
      if (qname === T && run) {
        if (selfClosing) {
          atoms.push({ kind: 'text', tagStart: lt, tagEnd: gt + 1, contentStart: gt + 1, contentEnd: gt + 1, selfClosing: true, text: '', runTag: xml.slice(run.start, run.openEnd), runQName: run.qname, beforeText: xml.slice(run.openEnd, lt) })
          continue
        }
        const close = xml.indexOf(`</${T}`, gt + 1)
        if (close === -1) break
        const closeEnd = tagEnd(xml, close + 2)
        atoms.push({
          kind: 'text', tagStart: lt, tagEnd: gt + 1, contentStart: gt + 1, contentEnd: close, selfClosing: false,
          text: decodeText(xml.slice(gt + 1, close)), runTag: xml.slice(run.start, run.openEnd), runQName: run.qname, beforeText: xml.slice(run.openEnd, lt)
        })
        i = closeEnd === -1 ? xml.length : closeEnd + 1
        continue
      }
      const breakType = /\btype\s*=\s*["']([^"']*)["']/.exec(xml.slice(lt, gt))?.[1]
      const isSep = dialect === 'w'
        ? run !== null && (qname === TAB || qname === CR || (qname === BR && (breakType === undefined || breakType === 'textWrapping')))
        : qname === BR && run === null && stack.length - 1 === para.index
      if (isSep) {
        let end = gt + 1
        if (!selfClosing) {
          const close = xml.indexOf(`</${qname}`, gt + 1)
          const closeEnd = close === -1 ? -1 : tagEnd(xml, close + 2)
          if (closeEnd === -1) break
          end = closeEnd + 1
          i = end
        }
        atoms.push({ kind: 'sep', char: qname === TAB ? '\t' : '\n', start: lt, end })
        continue
      }
      if (qname === END_PARA && stack.length - 1 === para.index) {
        let end = gt + 1
        if (!selfClosing) {
          const close = xml.indexOf(`</${qname}`, gt + 1)
          const closeEnd = close === -1 ? -1 : tagEnd(xml, close + 2)
          if (closeEnd !== -1) end = closeEnd + 1
        }
        para.frame.paragraph!.endParaRPr = { start: lt, end, raw: xml.slice(lt, end) }
        if (!selfClosing) i = end
        continue
      }
    }
    if (!selfClosing) {
      stack.push({ qname, start: lt, openEnd: gt + 1 })
      if (qname === FALLBACK) fallbackDepth += 1
    }
  }
  return paragraphs
}

function paragraphText(p: ParagraphScan): string {
  return p.atoms.map((a) => (a.kind === 'text' ? a.text : a.char)).join('')
}

export function readParagraphs(xml: string, dialect: TextDialect): TextParagraph[] {
  return scan(xml, dialect).map((p) => ({ text: paragraphText(p), group: p.group }))
}

/** 先頭から一致する長さ（サロゲートペアの途中では切らない） */
function commonPrefix(a: string, b: string): number {
  const max = Math.min(a.length, b.length)
  let n = 0
  while (n < max && a.charCodeAt(n) === b.charCodeAt(n)) n += 1
  if (n > 0 && n < max && isHighSurrogate(a.charCodeAt(n - 1))) n -= 1
  return n
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

function commonSuffix(a: string, b: string, limit: number): number {
  let n = 0
  while (n < limit && a.charCodeAt(a.length - 1 - n) === b.charCodeAt(b.length - 1 - n)) n += 1
  // 低いサロゲートだけを残さない
  if (n > 0 && n < limit && isHighSurrogate(a.charCodeAt(a.length - 1 - n))) n -= 1
  return n
}

/**
 * 並んだ run の文字（texts）を、つないだ文字が next になるように直す。変わった所だけを、その位置の run に入れる。
 * 足した文字は、直前の文字を持つ run に続ける（そこで打ち足したのと同じ）。先頭なら最初の run
 */
export function distributeText(texts: readonly string[], next: string): string[] {
  const old = texts.join('')
  if (old === next) return [...texts]
  if (texts.length === 0) return []
  const p = commonPrefix(old, next)
  const s = commonSuffix(old, next, Math.min(old.length, next.length) - p)
  const regionEnd = old.length - s
  const replacement = next.slice(p, next.length - s)
  let insertAt = -1
  let offset = 0
  const ranges = texts.map((text) => {
    const range = { a: offset, b: offset + text.length }
    offset += text.length
    return range
  })
  if (regionEnd > p) {
    // 消す・置き換える：消した所の始まりを持つ run に入れる
    for (let k = 0; k < ranges.length; k += 1) if (ranges[k]!.a <= p && p < ranges[k]!.b) { insertAt = k; break }
  } else {
    // 足すだけ：直前の文字を持つ run に続ける
    for (let k = 0; k < ranges.length; k += 1) if (ranges[k]!.a < p && p <= ranges[k]!.b) { insertAt = k; break }
  }
  if (insertAt === -1) for (let k = 0; k < ranges.length; k += 1) if (ranges[k]!.a <= p && p <= ranges[k]!.b) { insertAt = k; break }
  if (insertAt === -1) insertAt = 0
  return texts.map((text, k) => {
    const { a } = ranges[k]!
    const clamp = (n: number) => Math.max(0, Math.min(text.length, n))
    return text.slice(0, clamp(p - a)) + (k === insertAt ? replacement : '') + text.slice(clamp(regionEnd - a))
  })
}

interface Replacement {
  start: number
  end: number
  text: string
}

function withPreserve(startTag: string, dialect: TextDialect): string {
  if (dialect !== 'w' || /\bxml:space\s*=/.test(startTag)) return startTag
  return startTag.replace(/\s*\/?>$/, (end) => ` xml:space="preserve"${end.trim() === '/>' ? '/>' : '>'}`)
}

/** 文字の要素1つの中身を差し替える */
function setAtomText(xml: string, atom: Extract<Atom, { kind: 'text' }>, value: string, dialect: TextDialect, tQName: string, rawContent?: string): Replacement {
  const content = rawContent ?? escapeXmlText(value)
  const startTag = xml.slice(atom.tagStart, atom.tagEnd)
  if (atom.selfClosing) {
    const open = withPreserve(startTag.replace(/\s*\/>$/, '>'), dialect)
    return { start: atom.tagStart, end: atom.tagEnd, text: `${open}${content}</${tQName}>` }
  }
  if (content !== '' && dialect === 'w') {
    const open = withPreserve(startTag, dialect)
    if (open !== startTag) return { start: atom.tagStart, end: atom.contentEnd, text: `${open}${content}` }
  }
  return { start: atom.contentStart, end: atom.contentEnd, text: content }
}

/** 段落を作り直すときの、区切りを含む文字の XML（最初の文字の要素の中身として入れる） */
function rebuiltContent(next: string, dialect: TextDialect, prefix: string, atom: Extract<Atom, { kind: 'text' }>): string {
  const T = qualify(prefix, 't')
  if (dialect === 'w') {
    return next.split(/(\n|\t)/).map((part) => {
      if (part === '\n') return `</${T}><${qualify(prefix, 'br')}/><${T} xml:space="preserve">`
      if (part === '\t') return `</${T}><${qualify(prefix, 'tab')}/><${T} xml:space="preserve">`
      return escapeXmlText(part)
    }).join('')
  }
  // PowerPoint の改行は run の外（a:br）。run を閉じて、同じ書式の run を開き直す
  const lines = next.split('\n')
  const reopen = `</${T}></${atom.runQName}><${qualify(prefix, 'br')}/>${atom.runTag}${atom.beforeText}<${T}>`
  return lines.map(escapeXmlText).join(reopen)
}

/**
 * 段落の文字を差し替えた XML。edits は段落の番号（readParagraphs の並び）→ 新しい文字。
 * 番号が範囲の外・文字が同じものは無視する
 */
export function applyParagraphEdits(xml: string, dialect: TextDialect, edits: ReadonlyMap<number, string>): string {
  if (edits.size === 0) return xml
  const prefix = prefixOf(xml, NAMESPACES[dialect])
  if (prefix === null) return xml
  const T = qualify(prefix, 't')
  const paragraphs = scan(xml, dialect)
  const replacements: Replacement[] = []
  for (const [index, next] of edits) {
    const p = paragraphs[index]
    if (!p) continue
    const normalized = next.replace(/\r\n?/g, '\n')
    if (paragraphText(p) === normalized) continue
    replacements.push(...paragraphReplacements(xml, p, normalized, dialect, prefix, T))
  }
  // 後ろから当てる（前の位置がずれない）
  replacements.sort((x, y) => y.start - x.start)
  let out = xml
  let guard = Number.POSITIVE_INFINITY
  for (const r of replacements) {
    // 重なる差し替えは当てない（入れ子の段落が両方とも変わったときの外側の重複など）
    if (r.end > guard) continue
    out = out.slice(0, r.start) + r.text + out.slice(r.end)
    guard = r.start
  }
  return out
}

function paragraphReplacements(xml: string, p: ParagraphScan, next: string, dialect: TextDialect, prefix: string, T: string): Replacement[] {
  const textAtoms = p.atoms.filter((a): a is Extract<Atom, { kind: 'text' }> => a.kind === 'text')
  const seps = p.atoms.filter((a): a is Extract<Atom, { kind: 'sep' }> => a.kind === 'sep')
  const sepChars = dialect === 'w' ? /(\n|\t)/ : /(\n)/
  const pieces = next.split(sepChars)
  const nextSegments = pieces.filter((_, k) => k % 2 === 0)
  const nextSeps = pieces.filter((_, k) => k % 2 === 1)
  const sameSeps = nextSeps.length === seps.length && nextSeps.every((c, k) => c === seps[k]!.char)
  // 古い区切りで分けた文字の要素のまとまり
  const groups: Extract<Atom, { kind: 'text' }>[][] = [[]]
  for (const atom of p.atoms) {
    if (atom.kind === 'sep') groups.push([])
    else groups[groups.length - 1]!.push(atom)
  }
  const oldTextsHaveSeps = textAtoms.some((a) => (dialect === 'w' ? /[\n\t]/ : /\n/).test(a.text))
  const fits = sameSeps && !oldTextsHaveSeps && groups.every((g, k) => g.length > 0 || nextSegments[k] === '')
  if (fits) {
    const out: Replacement[] = []
    groups.forEach((group, k) => {
      if (group.length === 0) return
      const distributed = distributeText(group.map((a) => a.text), nextSegments[k] ?? '')
      group.forEach((atom, n) => { if (distributed[n] !== atom.text) out.push(setAtomText(xml, atom, distributed[n]!, dialect, T)) })
    })
    return out
  }
  // 区切りの並びが変わった：最初の文字の要素に全部を入れ、ほかの文字と区切りは消す
  const first = dialect === 'a' ? (textAtoms.find((a) => a.runQName === qualify(prefix, 'r')) ?? textAtoms[0]) : textAtoms[0]
  if (!first) return insertRun(xml, p, next, dialect, prefix, T)
  const out: Replacement[] = [setAtomText(xml, first, next, dialect, T, rebuiltContent(next, dialect, prefix, first))]
  for (const atom of textAtoms) if (atom !== first && atom.text !== '') out.push(setAtomText(xml, atom, '', dialect, T))
  for (const sep of seps) out.push({ start: sep.start, end: sep.end, text: '' })
  return out
}

/** 文字の要素が1つも無い段落へ run を足す */
function insertRun(xml: string, p: ParagraphScan, next: string, dialect: TextDialect, prefix: string, T: string): Replacement[] {
  if (next === '') return []
  const R = qualify(prefix, 'r')
  let run: string
  if (dialect === 'w') {
    const content = next.split(/(\n|\t)/).map((part) => (part === '\n' ? `<${qualify(prefix, 'br')}/>` : part === '\t' ? `<${qualify(prefix, 'tab')}/>` : part === '' ? '' : `<${T} xml:space="preserve">${escapeXmlText(part)}</${T}>`)).join('')
    run = `<${R}>${content}</${R}>`
  } else {
    // 段落の終わりの書式（a:endParaRPr）を、足す run の書式にする（同じ型）
    const end = p.endParaRPr?.raw
    const rPrName = qualify(prefix, 'rPr')
    const rPr = end ? end.replace(new RegExp(`^<${qualify(prefix, 'endParaRPr')}`), `<${rPrName}`).replace(new RegExp(`</${qualify(prefix, 'endParaRPr')}>$`), `</${rPrName}>`) : ''
    run = next.split('\n').map((line) => `<${R}>${rPr}<${T}>${escapeXmlText(line)}</${T}></${R}>`).join(`<${qualify(prefix, 'br')}/>`)
  }
  if (p.selfClosing) {
    const open = xml.slice(p.openStart, p.openEnd).replace(/\s*\/>$/, '>')
    const P = qualify(prefix, 'p')
    return [{ start: p.openStart, end: p.openEnd, text: `${open}${run}</${P}>` }]
  }
  // PowerPoint は a:endParaRPr の前（run は段落の終わりの書式より前に置く決まり）
  const at = dialect === 'a' && p.endParaRPr ? p.endParaRPr.start : p.closeStart
  return [{ start: at, end: at, text: run }]
}
