import { useQuery } from "@tanstack/react-query";
import { authApi } from "../services/auth.api";
import { AUTH_QUERY_KEY } from "../lib/queryKeys";

export { AUTH_QUERY_KEY };

export function useAuth() {
  const query = useQuery({
    queryKey: AUTH_QUERY_KEY,
    queryFn: authApi.me,
    retry: false,
    staleTime: 5 * 60 * 1000,
  });

  return {
    user: query.data,
    isLoading: query.isPending,
    refetch: query.refetch,
  };
}
