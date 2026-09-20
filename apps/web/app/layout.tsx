import type { ReactNode } from "react";

/**
 * Next requires a root layout, but the document language depends on the
 * locale segment below it, so `<html>` is rendered in `app/[locale]/layout`
 * where the locale is known. This layout only passes children through.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return children;
}
