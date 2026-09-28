import { Toaster as Sonner } from "sonner";

type ToasterProps = React.ComponentProps<typeof Sonner>;

// React's CSSProperties type does not admit sonner's custom --normal-*
// properties, so the object needs the cast to typecheck.
const toastSurface = {
  "--normal-bg": "var(--popover)",
  "--normal-bg-hover": "var(--accent)",
  "--normal-text": "var(--popover-foreground)",
  "--normal-border": "var(--border)",
  "--normal-border-hover": "var(--border)",
} as React.CSSProperties;

const Toaster = ({ ...props }: ToasterProps) => {
  return <Sonner theme="dark" style={toastSurface} {...props} />;
};

export { Toaster };
