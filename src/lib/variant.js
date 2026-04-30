/**
 * Pick a variant by weight. If no variants, returns null (caller should fall back to html_template).
 */
function pickVariant(landingPage) {
  if (!landingPage?.variants || landingPage.variants.length === 0) return null;
  const variants = landingPage.variants;
  const totalWeight = variants.reduce((s, v) => s + (v.weight || 1), 0);
  let r = Math.random() * totalWeight;
  for (const v of variants) {
    r -= (v.weight || 1);
    if (r <= 0) return v;
  }
  return variants[variants.length - 1];
}

module.exports = { pickVariant };
