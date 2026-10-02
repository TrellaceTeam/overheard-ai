/**
 * Where the credit links. The query string tells Trellace's site analytics the
 * visit came from the app. Nothing leaves the machine unless someone clicks.
 */
export const TRELLACE_URL = "https://www.trellace.com/?utm_source=overheard-ai&utm_medium=app";

/** "Built by Trellace", with Trellace opening the maintainer's site in a new tab. */
export function TrellaceCredit() {
  return (
    <>
      Built by{" "}
      <a
        href={TRELLACE_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="underline-offset-2 hover:text-foreground hover:underline"
      >
        Trellace
      </a>
    </>
  );
}
