// Marks long inline code (24+ characters by default) with a class, so the stylesheet can let
// only those tokens break mid-word inside table cells. Short code such as `setParameter`
// keeps its column at least as wide as the token, which is what makes tables readable.
export default function rehypeLongCode({ minLength = 24, className = "as-long-code" } = {}) {
  const text = (node) => (node.type === "text" ? node.value : (node.children ?? []).map(text).join(""));
  const walk = (node, parent) => {
    if (node.type === "element") {
      if (node.tagName === "code" && parent?.tagName !== "pre" && text(node).length >= minLength) {
        const existing = node.properties.className;
        node.properties.className = Array.isArray(existing) ? [...existing, className] : existing ? [String(existing), className] : [className];
      }
      for (const child of node.children ?? []) walk(child, node);
    } else if (node.type === "root") {
      for (const child of node.children) walk(child, node);
    }
  };
  return (tree) => walk(tree, null);
}
