export type Request = {
  cookies?: Record<string, string>;
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, string | undefined>;
  params: Record<string, string>;
  body: unknown;
};

export type Reply = {
  setCookie: (name: string, value: string, options?: Record<string, unknown>) => void;
  clearCookie: (name: string, options?: Record<string, unknown>) => void;
};

export type AuthedRequest = Request & {
  user?: {
    id: string;
    email: string;
    name: string;
    role: "customer" | "admin";
  };
};
