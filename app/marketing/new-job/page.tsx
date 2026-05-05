import { redirect } from "next/navigation";

export const metadata = {
  title: "Create Weekly Social Posts · Aries AI",
};

export default function MarketingNewJobPage() {
  redirect("/social-content/new");
}
