// lib/maintainxExtract.js — v0.47
//
// Field extraction helpers for MaintainX work-order responses. Tuned to
// the actual response shape from the Caper/Instacart org (477835), where
// most tickets are Cart-Tech ops with the store name + address embedded
// in the `description` rather than `locationId` (which is often null).
//
// Exports:
//   parseCaperDescription(text)       → { store_name, address }
//   parseCartRangeFromTitle(title)    → { cart_count, cart_first, cart_last }
//   countSubWOsFromProgress(progress) → integer
//   classifyMxWorkType(workOrder)     → 'deployment' | 'retrofit' | 'service' | 'repair' | null

// Description patterns we've seen in the wild (Caper org):
//   "Swap carts 6-10 at Market & Eatery 350 - 8800 Maurer Blvd Lenexa, KS 66219"
//   "Replace Cart #4 at Whole Foods Englewood - 100 Lincoln Ave, Englewood NJ 07631"
//   "Service visit at ShopRite Paramus - 250 Bergen Mall, Paramus, NJ"
//   "Calibrate carts at Stop & Shop Weehawken"   (no trailing address)
function parseCaperDescription(text) {
  const out = { store_name: null, address: null };
  if (!text || typeof text !== 'string') return out;

  // First line only — multi-line descriptions have prose after.
  const firstLine = text.split(/\r?\n/)[0].trim();

  // Anchored to "at <STORE>" — STORE runs until " - " (address separator)
  // or end-of-line. STORE allows letters/numbers/spaces and the chars
  // common in store names: & ' . , #
  const m = firstLine.match(/\bat\s+(.+?)(?:\s+-\s+(.+))?$/i);
  if (m) {
    const candidate = m[1].trim();
    // Sanity: skip obvious non-store matches like "at the same time"
    if (candidate.length >= 3 && candidate.length <= 80 && /[A-Za-z]/.test(candidate)) {
      out.store_name = candidate;
    }
    if (m[2]) {
      const addr = m[2].trim();
      if (addr.length >= 6 && addr.length <= 200) {
        // Strip trailing punctuation
        out.address = addr.replace(/[\s.;:]+$/, '');
      }
    }
  }
  return out;
}

// Title patterns:
//   "Cart Swap - Carts #6 - #10"  → range 6..10 = 5 carts
//   "Replace Cart #4"             → single, count = 1
//   "Cart Swap - Cart #7"         → single, count = 1
function parseCartRangeFromTitle(title) {
  if (!title) return { cart_count: null, cart_first: null, cart_last: null };
  // Range: "#N - #M" (or "#N-#M" or "Carts N-M")
  const range = title.match(/#?\s*(\d{1,4})\s*[-–—]\s*#?\s*(\d{1,4})/);
  if (range) {
    const a = Number(range[1]), b = Number(range[2]);
    if (a > 0 && b >= a && (b - a) < 100) {
      return { cart_count: b - a + 1, cart_first: a, cart_last: b };
    }
  }
  // Single: "Cart #4" or "Cart 4"
  const single = title.match(/cart\s*#?\s*(\d{1,4})\b/i);
  if (single) {
    const n = Number(single[1]);
    if (n > 0 && n < 1000) return { cart_count: 1, cart_first: n, cart_last: n };
  }
  return { cart_count: null, cart_first: null, cart_last: null };
}

// MaintainX `progress` object on a parent WO: counts of children by status.
//   progress: { openCount, inProgressCount, onHoldCount, doneCount }
// Sum = total number of sub-WOs.
function countSubWOsFromProgress(progress) {
  if (!progress || typeof progress !== 'object') return 0;
  const fields = ['openCount', 'inProgressCount', 'onHoldCount', 'doneCount', 'cancelledCount'];
  return fields.reduce((s, k) => s + (Number(progress[k]) || 0), 0);
}

// Best-effort work_type from a MaintainX WO body:
//   - extraFields["Service Type"] / ["Work Type"] / ["Visit Type"] (admin-defined)
//   - title keywords: "deploy", "retrofit", "swap"/"repair"/"replace"
//   - type field: "REACTIVE" → service/repair, "PREVENTIVE" → service
const WT_KEYWORDS = [
  { wt: 'deployment', re: /\b(deploy|deployment|new\s+store|launch|install)/i },
  { wt: 'retrofit',   re: /\b(retrofit|upgrade|firmware|tu\s*check)/i },
  { wt: 'repair',     re: /\b(repair|swap|replace|broken|fix|fault|issue)/i },
  { wt: 'service',    re: /\b(service|inspection|calibrat|maintenance|check|tune)/i },
];
function classifyMxWorkType(w) {
  if (!w) return null;
  const ef = (w.extraFields && typeof w.extraFields === 'object') ? w.extraFields : {};
  // 1. Admin-defined custom field
  for (const [k, v] of Object.entries(ef)) {
    const key = k.toLowerCase().trim();
    if (['service type', 'work type', 'visit type', 'wo type'].includes(key) && typeof v === 'string') {
      const lc = v.toLowerCase();
      if (/deploy|new\s+store/.test(lc))      return 'deployment';
      if (/retrofit|upgrade|firmware/.test(lc)) return 'retrofit';
      if (/repair|swap|replace|fix/.test(lc))  return 'repair';
      if (/service|inspect|calibrat|tune/.test(lc)) return 'service';
    }
  }
  // 2. Keyword scan over title + description
  const hay = `${w.title || ''}\n${w.description || ''}`;
  for (const { wt, re } of WT_KEYWORDS) if (re.test(hay)) return wt;
  // 3. Type field as last resort
  if (w.type === 'REACTIVE')   return 'repair';
  if (w.type === 'PREVENTIVE') return 'service';
  return null;
}

module.exports = {
  parseCaperDescription,
  parseCartRangeFromTitle,
  countSubWOsFromProgress,
  classifyMxWorkType,
};
