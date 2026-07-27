import { redirect } from "next/navigation";

export default function Home() {
  redirect("/api/v1/session/bootstrap?returnTo=%2Fcampaigns");
}
