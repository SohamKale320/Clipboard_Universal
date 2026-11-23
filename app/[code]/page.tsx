import { notFound } from "next/navigation";
import Clipboard from "@/components/Clipboard";

export default async function CodePage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  if (!/^\d{6}$/.test(code)) notFound();
  return <Clipboard initialCode={code} />;
}
