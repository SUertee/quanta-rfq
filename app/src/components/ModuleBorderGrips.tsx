/** Narrow drag surfaces keep touch dragging separate from text selection and scrolling. */
export function ModuleBorderGrips() {
  return <div className="module-border-grips" aria-hidden="true">
    <span data-module-reference className="module-border-top" />
    <span data-module-reference className="module-border-right" />
    <span data-module-reference className="module-border-bottom" />
    <span data-module-reference className="module-border-left" />
  </div>;
}
