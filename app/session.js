/**
 * Document session: translates editor state into a plan for the splice layer.
 *
 * Data flows one way, and never back:
 *
 *   .md on disk ──► MdDoc (source of truth, holds every original byte)
 *                     │
 *                     └─► editor (reads only; never decides what gets saved)
 *                            │ edits
 *                            ▼
 *                     identity reconciliation ──► save plan ──► MdDoc.save() ──► disk
 *
 * The editor's own `getMarkdown()` never participates in saving: measured across
 * real-world READMEs it preserved bytes 0 times out of 14, and it silently drops
 * every link definition. Its one legitimate use is serializing **newly inserted
 * blocks**, which by definition have no original bytes to reuse.
 */

import { editorViewCtx, serializerCtx } from '@milkdown/kit/core';
import { MdDoc, restyle } from '../src/splice.js';
import { buildMapping, guardSave } from '../src/mapping.js';
import { reconcileByIdentity } from '../src/reconcile.js';
import { restoreCalloutMarkers } from './editor/callout.js';

export class DocumentSession {
  /**
   * @param {string} source Raw file contents
   * @param {string} [name] Display file name
   */
  constructor(source, name = 'untitled.md') {
    this.name = name;
    this.source = source;
    this.doc = new MdDoc(source);
    /** @type {any[]} */
    this.baselineNodes = [];
    /** @type {ReturnType<typeof buildMapping>|null} */
    this.mapping = null;
    this.mappingError = null;
  }

  /** Call once the editor exists: capture baseline nodes and build the mapping. */
  attach(ctx) {
    this.ctx = ctx;
    const doc = ctx.get(editorViewCtx).state.doc;
    this.baselineNodes = [];
    const types = [];
    doc.forEach((n) => {
      this.baselineNodes.push(n);
      types.push(n.type.name);
    });

    const mapping = buildMapping(this.doc.blocks, types);
    this.mapping = mapping;
    const gate = guardSave(mapping);
    this.mappingError = gate.safe ? null : gate.message;
    return gate;
  }

  /** Current top-level nodes of the editor document. */
  currentNodes() {
    const nodes = [];
    this.ctx.get(editorViewCtx).state.doc.forEach((n) => nodes.push(n));
    return nodes;
  }

  /**
   * Serialize a single ProseMirror node — only for blocks with no reusable bytes.
   * @param {any} node
   * @param {string} styleSource Original text whose style to follow (see `restyle`)
   */
  serializeNode(node, styleSource = this.doc.body) {
    const schema = this.ctx.get(editorViewCtx).state.schema;
    const serialize = this.ctx.get(serializerCtx);
    const wrapper = schema.nodes.doc.create(null, [node]);
    // Callout markers last: restyle() prints `[!NOTE]` escaped again.
    return restoreCalloutMarkers(restyle(serialize(wrapper), styleSource)).replace(/\n+$/, '');
  }

  /**
   * For each fresh slot, the original block it most likely replaced: an unreused
   * baseline node of the same type, paired in document order. An edit in place pairs
   * with its own original; a block with no candidate follows the whole document.
   * @returns {Map<number, string>} slot → style source
   */
  styleSources(plan, nodes) {
    const used = new Set(plan.map((e) => e.fromOld).filter((i) => i !== null));
    const free = this.baselineNodes.map((_, i) => i).filter((i) => !used.has(i));
    const out = new Map();
    let from = 0;
    plan.forEach((entry, slot) => {
      if (entry.fromOld !== null) return;
      const k = free.findIndex((i, n) => n >= from && this.baselineNodes[i].type === nodes[slot].type);
      if (k < 0) return;
      from = k + 1;
      out.set(slot, this.doc.sourceOf(this.mapping.pmToBlock[free[k]]));
    });
    return out;
  }

  /**
   * Compute the current save plan.
   * @returns {{visibleOrder:(number|{text:string})[], reused:number, fresh:number}|null}
   */
  plan() {
    if (!this.mapping?.ok) return null;
    const nodes = this.currentNodes();
    const plan = reconcileByIdentity(this.baselineNodes, nodes);
    const styles = this.styleSources(plan, nodes);

    let reused = 0;
    let fresh = 0;
    const visibleOrder = plan.map((entry, slot) => {
      if (entry.fromOld === null) {
        fresh++;
        return { text: this.serializeNode(nodes[slot], styles.get(slot)) };
      }
      reused++;
      return this.mapping.pmToBlock[entry.fromOld];
    });

    return { visibleOrder, reused, fresh };
  }

  /** Produce the final file contents. */
  save() {
    if (!this.mapping?.ok) {
      // Mapping unusable: never write back by position. Return the original and let
      // the caller surface the problem.
      return this.source;
    }
    const p = this.plan();
    return this.doc.save({ visibleOrder: p.visibleOrder });
  }

  /** Snapshot for the status bar. */
  status() {
    if (!this.mapping?.ok) {
      return { ok: false, message: this.mappingError, identical: false, reused: 0, fresh: 0, hidden: 0 };
    }
    const p = this.plan();
    const out = this.doc.save({ visibleOrder: p.visibleOrder });
    return {
      ok: true,
      identical: out === this.source,
      reused: p.reused,
      fresh: p.fresh,
      hidden: this.doc.hiddenIndices().length,
      bytes: out.length,
      originalBytes: this.source.length,
    };
  }

  /** After a successful save, adopt the written contents as the new baseline. */
  commit(newSource) {
    this.source = newSource;
    this.doc = new MdDoc(newSource);
    return this.attach(this.ctx);
  }
}
