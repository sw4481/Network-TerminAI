import { useEffect, useState } from "react";
import { parseShow, ParseArgs, ParseResponse } from "../lib/parsers";

export function useParsedOutput<T = unknown>(args: ParseArgs | null) {
  const [state, setState] = useState<{ loading: boolean; data: ParseResponse<T> | null; error: string | null }>({
    loading: false, data: null, error: null,
  });
  useEffect(() => {
    if (!args) {
      setState({ loading: false, data: null, error: null });
      return;
    }
    let cancelled = false;
    setState({ loading: true, data: null, error: null });
    parseShow<T>(args)
      .then((data) => { if (!cancelled) setState({ loading: false, data, error: null }); })
      .catch((err) => { if (!cancelled) setState({ loading: false, data: null, error: String(err) }); });
    return () => { cancelled = true; };
  }, [args?.vendor, args?.platform, args?.command, args?.raw]);
  return state;
}
