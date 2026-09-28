import { useQuery } from "@tanstack/react-query";
import { getProject } from "@/server/api/projects";

/**
 * Whether a project is the built-in demo, for the pages that must disable
 * their controls on it. Shares the project shell's cached query (same key,
 * same fn), so a child route asking costs no extra request.
 */
export function useIsDemo(projectId: string): boolean {
  const { data } = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => getProject({ data: { projectId } }),
  });
  return data?.isDemo === true;
}
