import { permanentRedirect } from "next/navigation";

export default function ApiDocsPage() {
  permanentRedirect("/docs");
}
