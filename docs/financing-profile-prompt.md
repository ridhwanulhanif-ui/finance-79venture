# Financing Profile workbook: prompt for Claude

The Financing Profile on Railway cannot reach QuickBooks. It shows the profile from an Excel file instead,
imported with **Import Excel…** on the Financing Profile page. There are two ways to make that file:

1. **Export from claude.ai (exact).** Open the dashboard artifact on claude.ai, go to Financing Profile, pick
   the company and month, then press **Export Excel**. The file is built from the same calculation the page uses.
2. **Ask Claude.** Paste the prompt below into a claude.ai chat that has the QuickBooks connector
   (Meridian Connector for QuickBooks) turned on. Run it once per company.

The import matches sheets and lines by name, so the names below must stay exactly as written.

---

## Prompt

```
Using the QuickBooks connector, prepare a Financing Profile workbook (.xlsx) for
COMPANY = 79 Ventures Sdn Bhd            <- or: Arabina Eco Tiny Homes Sdn Bhd
PERIOD END = the last day of last month  <- or a date such as 2026-09-30

Use accrual basis throughout. Y = the year of PERIOD END.

Pull these reports for COMPANY:
- Profit and loss from 1 Jan of Y-1 to PERIOD END, one column per year.
- Balance sheet by month from 1 Dec of Y-1 to PERIOD END.
- Aged receivables and aged payables as at PERIOD END.
- Sales by customer from 1 Jan of Y to PERIOD END.

Build a workbook with exactly these sheets, header rows and line names. Write amounts as plain
numbers to 2 decimals: no "RM", no thousands separators, negatives with a minus sign.

Sheet "Info" (columns: Field | Value)
  Company                 | COMPANY, spelled exactly as above
  Period end              | PERIOD END as YYYY-MM-DD
  Prior year end          | Dec <Y-1>
  Pulled from QuickBooks  | today's date and time, YYYY-MM-DD HH:MM
  Basis                   | Accrual, management accounts, unaudited

Sheet "Results" (columns: Line | FY<Y-1> | YTD <Y>-<MM>)
  Revenue                  = Total Income
  Cost of sales            = Total Cost of Goods Sold
  Gross profit             = Gross Profit
  Other income             = Total Other Income
  Operating expenses       = Total Expenses
  Other expenses           = Total Other Expenses
  Net profit               = Net Earnings (net income)
  Finance cost             = Total Finance Cost (Interest on Financing/HP), plus any account named
                             "profit to investors"
  Depreciation             = sum of every account whose name contains "depreciation"
  Tax expense              = sum of accounts named "Corporate taxation" or "CP204" (0 if none)
  Sales to related company = leave FY blank; YTD = sales by customer to the other group company
                             (Arabina or 79 Ventures), 0 if none

Sheet "Position" (columns: Line | Prior year end | As at)
  Prior year end is the Dec <Y-1> column; As at is the PERIOD END column.
  Cash and deposits              = Total Cash at Bank + every fixed deposit or term deposit account
  Trade receivables              = Total Accounts Receivable
  Inventory and goods in transit = sum of accounts whose name contains "inventor" or "good in transit"
  Total current assets           = Total Current Assets
  Non-current assets             = Total Long-term assets (or Total Non-current / Fixed Assets)
  Total assets                   = Total Assets
  Trade payables                 = Total Accounts Payable
  Customer deposits              = Total Customer Deposit(s)
  Total current liabilities      = Total Current Liabilities
  Non-current liabilities        = Total Non-current Liabilities (or Total Long-term Liabilities)
  Equity                         = Total Shareholders' equity
  Due to related company         = Total Due to Related Company, 0 if none

Sheet "Facilities" (columns: Facility | Type | Principal | Balance incl. future profit | Monthly instalment)
  One row for each account directly under Non-current Liabilities with a balance at PERIOD END.
  Facility    = the account name
  Type        = "Hire purchase" if the name has a vehicle plate (e.g. VQF4829) or says HP;
                otherwise "Term financing"
  Principal   = the account's total at PERIOD END (after unearned interest)
  Balance incl. future profit = the parent account's own balance at PERIOD END (the amount on the
                account's header line, before its unearned-interest sub-account); if there is no
                sub-account, the same as Principal
  Monthly instalment = how much that balance fell from one month to the next over the last three
                months; take the middle value of the falls, ignore months where it rose; blank if it
                never fell
  Then one row for each sub-account under Investor Financing:
  Facility = the account name, Type = "Investor", Principal = its balance, other columns blank.

Sheet "Ageing" (columns: Bucket | Receivables | Payables)
  Rows Current, 1 - 30, 31 - 60, 61 - 90, 91 and Over, Total from the TOTAL line of each ageing report.

Sheet "Customers" (columns: Customer | Sales YTD)
  Every customer with sales from 1 Jan of Y to PERIOD END, largest first.

Before giving me the file, check that Total assets equals Total current liabilities + Non-current
liabilities + Equity at both dates, and list any line you could not find in QuickBooks instead of
guessing a number. Name the file "Financing Profile <79V or Arabina> <PERIOD END>.xlsx".
```
