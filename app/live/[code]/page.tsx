import { notFound } from "next/navigation";
import LiveRoom from "@/components/LiveRoom";

export default async function LiveRoomPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  if (!/^\d{6}$/.test(code)) notFound();
  return <LiveRoom code={code} />;
}
