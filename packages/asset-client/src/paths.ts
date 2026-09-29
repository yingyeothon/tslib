export interface BundleBase {
  /** Always ends in `/`. */
  url: string;
  /**
   * What precedes a file's path in its associated data: `""` for a live
   * bundle, `"{version}/"` for a versioned one. Only known for a URL of the
   * `/assets/{bundleId}/[{version}/]` shape.
   */
  adPrefix: string | undefined;
}

const bundlePath = /^\/assets\/[^/]+\/(?:([^/]+)\/)?$/;

/**
 * An http(s) URL with no userinfo, query or fragment: those would end up in
 * a URL `fetch` rejects with a message that quotes it. An encrypted bundle's
 * base must also have the `/assets/{bundleId}/[{version}/]` shape, because
 * the associated data every file was encrypted under is derived from it.
 */
export function parseBaseUrl(baseUrl: unknown, encrypted: boolean): BundleBase {
  let url: URL;
  try {
    url = new URL(baseUrl as string);
  } catch {
    throw new RangeError("asset baseUrl must be an http(s) URL");
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new RangeError(
      "asset baseUrl must be an http(s) URL with a path and nothing else",
    );
  }
  const pathname = url.pathname.endsWith("/")
    ? url.pathname
    : `${url.pathname}/`;
  const match = bundlePath.exec(pathname);
  let adPrefix: string | undefined;
  if (match !== null) {
    const version = match[1];
    try {
      adPrefix = version === undefined ? "" : `${decodeURIComponent(version)}/`;
    } catch {
      adPrefix = undefined;
    }
  }
  if (encrypted && adPrefix === undefined) {
    throw new RangeError(
      "an encrypted bundle's baseUrl must be https://{cdn}/assets/{bundleId}/ or …/{bundleId}/{version}/",
    );
  }
  return { url: `${url.origin}${pathname}`, adPrefix };
}

/**
 * A file's path below the bundle: segments separated by `/`, no leading
 * slash, no empty, `.` or `..` segment, no backslash and no control
 * character. The error does not quote the path.
 */
export function checkPath(path: unknown): string {
  if (
    typeof path !== "string" ||
    path === "" ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f\\]/.test(path) ||
    // A lone surrogate has no UTF-8 form, and `encodeURIComponent` would
    // throw a `URIError` on it.
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
      path,
    ) ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new RangeError(
      "asset path must be relative segments separated by '/', with no '.', '..' or empty segment",
    );
  }
  return path;
}

/** Each segment percent-encoded: `v1/데이터/노래.db` is a valid object key. */
export function fileUrl(base: BundleBase, path: string): string {
  return base.url + path.split("/").map(encodeURIComponent).join("/");
}
