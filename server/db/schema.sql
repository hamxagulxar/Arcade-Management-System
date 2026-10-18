-- Arcade Management System — SQLite schema
-- Ported from the original SQL Server design (database/sqlserver/Arcade_Database.sql)
-- and extended for the full-stack app:
--   + Zone              (machines belong to a zone instead of a free-text Location)
--   + TokenRequest      (the priority queue, persisted)
--   + Session.Status/PlannedMinutes/RequestID (active / completed / cancelled sessions)
--   + Machine.TokenType (1 = Standard, 2 = Premium, 3 = Tournament) and richer statuses
--   + Employee.Username/PasswordHash (role-based login)

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS Membership (
  MembershipID   INTEGER PRIMARY KEY AUTOINCREMENT,
  MembershipType TEXT NOT NULL UNIQUE CHECK (MembershipType IN ('Basic','Silver','Gold','Platinum')),
  DiscountRate   REAL NOT NULL DEFAULT 0 CHECK (DiscountRate BETWEEN 0 AND 100),
  MonthlyFee     REAL NOT NULL DEFAULT 0 CHECK (MonthlyFee >= 0)
);

CREATE TABLE IF NOT EXISTS Zone (
  ZoneID    INTEGER PRIMARY KEY AUTOINCREMENT,
  ZoneName  TEXT NOT NULL UNIQUE COLLATE NOCASE,
  CreatedAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS Machine (
  MachineID   INTEGER PRIMARY KEY AUTOINCREMENT,
  ZoneID      INTEGER NOT NULL REFERENCES Zone(ZoneID),
  MachineName TEXT NOT NULL,
  GameType    TEXT NOT NULL,
  CreditCost  INTEGER NOT NULL CHECK (CreditCost > 0),          -- credits per 5-minute block
  TokenType   INTEGER NOT NULL DEFAULT 1 CHECK (TokenType IN (1,2,3)),
  Status      TEXT NOT NULL DEFAULT 'Available'
              CHECK (Status IN ('Available','In Use','Reserved','Out of Order','Under Maintenance','Decommissioned')),
  InstallDate TEXT
);

CREATE TABLE IF NOT EXISTS Employee (
  EmployeeID   INTEGER PRIMARY KEY AUTOINCREMENT,
  FirstName    TEXT NOT NULL,
  LastName     TEXT NOT NULL,
  Role         TEXT NOT NULL CHECK (Role IN ('Manager','Cashier','Technician','Security')),
  Shift        TEXT NOT NULL CHECK (Shift IN ('Morning','Evening','Night')),
  Salary       REAL NOT NULL CHECK (Salary >= 0),
  HireDate     TEXT NOT NULL DEFAULT (date('now')),
  Phone        TEXT,
  Username     TEXT UNIQUE COLLATE NOCASE,
  PasswordHash TEXT
);

CREATE TABLE IF NOT EXISTS Customer (
  CustomerID     INTEGER PRIMARY KEY AUTOINCREMENT,
  MembershipID   INTEGER REFERENCES Membership(MembershipID),
  FirstName      TEXT NOT NULL,
  LastName       TEXT NOT NULL,
  Phone          TEXT UNIQUE,
  Email          TEXT UNIQUE COLLATE NOCASE,
  CreditBalance  INTEGER NOT NULL DEFAULT 0 CHECK (CreditBalance >= 0),
  RewardPoints   INTEGER NOT NULL DEFAULT 0 CHECK (RewardPoints >= 0),
  JoinDate       TEXT NOT NULL DEFAULT (date('now')),
  ProfilePicture TEXT
);

CREATE TABLE IF NOT EXISTS TokenRequest (
  RequestID      INTEGER PRIMARY KEY AUTOINCREMENT,
  CustomerID     INTEGER NOT NULL REFERENCES Customer(CustomerID),
  Game           TEXT NOT NULL,                                  -- machine name or genre
  SessionMinutes INTEGER NOT NULL CHECK (SessionMinutes BETWEEN 5 AND 240),
  Priority       TEXT NOT NULL DEFAULT 'Normal' CHECK (Priority IN ('High','Normal')),
  Status         TEXT NOT NULL DEFAULT 'Waiting' CHECK (Status IN ('Waiting','Assigned','Rejected','Cancelled')),
  Note           TEXT,
  CreatedAt      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ResolvedAt     TEXT,
  SessionID      INTEGER
);

CREATE TABLE IF NOT EXISTS Session (
  SessionID      INTEGER PRIMARY KEY AUTOINCREMENT,
  CustomerID     INTEGER NOT NULL REFERENCES Customer(CustomerID),
  MachineID      INTEGER NOT NULL REFERENCES Machine(MachineID),
  RequestID      INTEGER REFERENCES TokenRequest(RequestID),
  StartTime      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  EndTime        TEXT,
  PlannedMinutes INTEGER NOT NULL DEFAULT 10 CHECK (PlannedMinutes > 0),
  CreditsUsed    INTEGER NOT NULL DEFAULT 0 CHECK (CreditsUsed >= 0),
  Score          INTEGER NOT NULL DEFAULT 0,
  Status         TEXT NOT NULL DEFAULT 'Active' CHECK (Status IN ('Active','Completed','Cancelled')),
  CONSTRAINT chk_session_time CHECK (EndTime IS NULL OR EndTime >= StartTime)
);

CREATE TABLE IF NOT EXISTS "Transaction" (
  TransactionID   INTEGER PRIMARY KEY AUTOINCREMENT,
  CustomerID      INTEGER NOT NULL REFERENCES Customer(CustomerID),
  EmployeeID      INTEGER NOT NULL REFERENCES Employee(EmployeeID),
  Amount          REAL NOT NULL CHECK (Amount > 0),
  PaymentMethod   TEXT NOT NULL CHECK (PaymentMethod IN ('Cash','Card','Online')),
  TransactionDate TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CreditsAdded    INTEGER NOT NULL CHECK (CreditsAdded > 0)
);

CREATE TABLE IF NOT EXISTS Maintenance (
  MaintenanceID    INTEGER PRIMARY KEY AUTOINCREMENT,
  MachineID        INTEGER NOT NULL REFERENCES Machine(MachineID),
  EmployeeID       INTEGER NOT NULL REFERENCES Employee(EmployeeID),
  IssueDescription TEXT NOT NULL,
  StartDate        TEXT NOT NULL DEFAULT (date('now')),
  EndDate          TEXT,
  ResolutionStatus TEXT NOT NULL DEFAULT 'Open' CHECK (ResolutionStatus IN ('Open','In Progress','Resolved'))
);

CREATE INDEX IF NOT EXISTS idx_machine_zone        ON Machine(ZoneID);
CREATE INDEX IF NOT EXISTS idx_machine_status      ON Machine(Status);
CREATE INDEX IF NOT EXISTS idx_session_customer    ON Session(CustomerID);
CREATE INDEX IF NOT EXISTS idx_session_machine     ON Session(MachineID);
CREATE INDEX IF NOT EXISTS idx_session_status      ON Session(Status);
CREATE INDEX IF NOT EXISTS idx_transaction_date    ON "Transaction"(TransactionDate);
CREATE INDEX IF NOT EXISTS idx_tokenrequest_status ON TokenRequest(Status);
CREATE INDEX IF NOT EXISTS idx_maintenance_machine ON Maintenance(MachineID);
