// Chemistry: \ce{H2O}, \ce{2H2 + O2 -> 2H2O}, \pu{9.8 m s^-2}. Registers on
// the shared KaTeX (one version app-wide via the pnpm override), so the
// chat (Streamdown), document editor, PDF and Word exports all support it.
import "katex/contrib/mhchem";

export { default } from "katex";
