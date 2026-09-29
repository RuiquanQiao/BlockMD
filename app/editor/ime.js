/**
 * Keys that belong to an input method (Chinese pinyin, Japanese, Korean…), not to us.
 *
 * While a candidate is being chosen, Enter confirms it and the arrow keys move through
 * the candidates. Chromium (Windows) sends those keys with isComposing set; WebKit
 * (macOS) sends the confirming Enter *after* compositionend with isComposing false —
 * keyCode 229 is the one sign both give. A handler that acts on them picks a menu item
 * or submits a form in the middle of someone typing 标题.
 */
export const isImeKey = (e) => e.isComposing || e.keyCode === 229;
