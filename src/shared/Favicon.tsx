import { useState } from "react";

export function Favicon({ url, size = 14 }: { url: string; size?: number }) {
  const [failed, setFailed] = useState(false);

  let faviconUrl = "";
  try {
    faviconUrl = `${new URL(url).origin}/favicon.ico`;
  } catch {
    return null;
  }

  if (failed) {
    return <span style={{ width: size, height: size, flexShrink: 0, display: "inline-block" }} />;
  }

  return (
    <img
      src={faviconUrl}
      width={size}
      height={size}
      alt=""
      style={{ flexShrink: 0, borderRadius: 2, objectFit: "contain", display: "inline-block" }}
      onError={() => setFailed(true)}
    />
  );
}
