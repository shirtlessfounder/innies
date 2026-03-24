declare module '*.js' {
  export const getPathSegments: (...args: any[]) => string[];
  export const proxyJsonRequest: (...args: any[]) => Promise<Response>;
  export const expireCookieHeader: (...args: any[]) => string;
  const defaultExport: any;
  export default defaultExport;
}
