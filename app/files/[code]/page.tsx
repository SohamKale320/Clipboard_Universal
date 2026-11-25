import { notFound } from "next/navigation";
import Files from "@/components/Files";

export default async function FileCodePage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  if (!/^\d{6}$/.test(code)) notFound();
  return <Files initialCode={code} />;
}
