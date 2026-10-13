"use client";

import Link from "next/link";

import { PageTitle } from "@/components/ui";
import { useAuth } from "@/lib/auth";

type Topic = { title: string; steps: string[]; link?: { href: string; label: string } };

const CASHIER: Topic[] = [
  { title: "Start your day", link: { href: "/day/start", label: "Start Day" }, steps: [
    "Press Start Day on the Home screen.",
    "Type the cash float: the money you were given to make change. Type 0 if there is none.",
    "Press Start Day. You can now sell.",
  ] },
  { title: "Record a sale on the Daily Sheet", link: { href: "/sheet", label: "Daily Sheet" }, steps: [
    "Press Daily Sheet. It is the same sheet as in Excel, one row for each product.",
    "Find the product. You can type part of its name in the “Find a product” box.",
    "Type the quantity sold in the “Add to Sales” box on that row and press Save.",
    "Check the Total to pay.",
    "Choose how the customer pays. For cash, type the money they handed you and the screen shows the change.",
    "Press Save sale and wait for the “Sale saved” message.",
    "Press Print Receipt if the customer wants one, then Back to the sheet. The Sales and Closing stock columns have changed.",
  ] },
  { title: "If the screen says it could not reach the shop system", steps: [
    "Nothing is lost. Your sale is still on the screen.",
    "Check the connection, then press Save sale again. The sale will be saved only once.",
  ] },
  { title: "You made a mistake on a sale", steps: [
    "A completed sale cannot be changed by the cashier.",
    "Tell the Accountant or Owner. They can cancel it or refund it, with a reason.",
  ] },
  { title: "Close your day", link: { href: "/day/close", label: "Close Day" }, steps: [
    "Press Close Day.",
    "Check your sales total.",
    "Count all the cash in the drawer, including the float, and type the amount.",
    "If it does not match, count again. If it is still different, write a short note.",
    "Press Review and Close, then Yes, close my shift.",
  ] },
];

const OFFICE: Topic[] = [
  { title: "Review a cashier's closing", link: { href: "/closing", label: "Daily Closing" }, steps: [
    "Open Daily Closing and press Review on the shift.",
    "Compare each mobile money and bank total with the phone or bank record, and tick it.",
    "For a cash difference, write how it was resolved.",
    "Press Approve this shift. You cannot approve a shift you ran yourself.",
  ] },
  { title: "Refund or return", link: { href: "/sales", label: "Sales" }, steps: [
    "Open Today's Sales, choose the day of the sale, and press View.",
    "Press Refund items. Type how many are coming back; tick Damaged if they cannot be resold.",
    "Choose how the money is given back and write the reason.",
    "The refund is recorded on today's day. The day of the original sale is never changed.",
  ] },
  { title: "Receive a delivery", link: { href: "/receive", label: "Receive Stock" }, steps: [
    "Choose the supplier and invoice number if you have them. Never guess.",
    "Add each product and type the quantity that actually arrived.",
    "Press Save delivery. Stock goes up straight away.",
  ] },
  { title: "Record an expense", link: { href: "/expenses", label: "Expenses" }, steps: [
    "Choose the category, type the amount and what it was for.",
    "If cash came out of a cashier's drawer, choose that drawer so the closing count still agrees.",
  ] },
  { title: "The two balances, and why they differ", steps: [
    "Cumulative sales balance: a running total of sales value. Closing = opening + net sales for the day. It carries to the next day.",
    "Cash in the drawer: float + cash sales − cash refunds − cash paid out. It is counted at closing.",
    "They are separate on purpose. Mobile money and bank payments are sales but are not cash.",
  ] },
];

const OWNER: Topic[] = [
  { title: "Before the first live day", link: { href: "/setup", label: "Setup" }, steps: [
    "Add products with selling prices.",
    "Have every product physically counted, entered on the count sheet, and approve the count.",
    "Create a cashier account.",
    "Enter the verified opening cumulative sales balance and its cutover date, then approve and go live.",
  ] },
  { title: "Add or switch off a user", link: { href: "/users", label: "Users" }, steps: [
    "Press Add User, choose the role and a first password. The person chooses their own at first sign-in.",
    "To stop someone signing in, press Edit and untick Active. Accounts are never deleted.",
  ] },
  { title: "Correct a closed day", link: { href: "/closing", label: "Daily Closing" }, steps: [
    "Only for formal accounting corrections. For a customer refund, use Refund items instead.",
    "In the balance history, press Correct… on the day, enter the amount and a clear reason.",
    "The original figures are kept and every later day is recalculated.",
  ] },
];

function Section({ heading, topics }: { heading: string; topics: Topic[] }) {
  return (
    <section>
      <h2 className="mb-3 text-xl font-bold">{heading}</h2>
      <div className="space-y-3">
        {topics.map((topic) => (
          <details key={topic.title} className="card">
            <summary className="cursor-pointer text-lg font-semibold">{topic.title}</summary>
            <ol className="ml-6 mt-3 list-decimal space-y-1">{topic.steps.map((step) => <li key={step}>{step}</li>)}</ol>
            {topic.link && <Link href={topic.link.href} className="btn-secondary mt-3">Go to {topic.link.label}</Link>}
          </details>
        ))}
      </div>
    </section>
  );
}

export default function HelpPage() {
  const { user } = useAuth();
  if (!user) return null;
  return (
    <div className="max-w-3xl space-y-6">
      <PageTitle title="Help" help="Step-by-step instructions for the most common tasks. Press a question to open it." />
      <Section heading="Daily selling" topics={CASHIER} />
      {user.role !== "CASHIER" && <Section heading="Accountant and Owner tasks" topics={OFFICE} />}
      {user.role === "OWNER" && <Section heading="Owner tasks" topics={OWNER} />}
    </div>
  );
}
