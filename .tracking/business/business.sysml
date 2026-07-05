// =====================================================================
// ProjectBusiness — the Business-layer artifacts for the SelfSync self-hosted Obsidian
// sync product (backfilled 2026-07-04, D0004 adoption). Brief -> Personas -> Needs.
// The three top Needs are the project's founding goals; sub-needs decompose them. Needs
// are solution-free desired outcomes; the HOW lives in requirements + architecture decisions.
// =====================================================================
package ProjectBusiness {
    private import EngineElement::*;
    private import EngineNeeds::*;
    private import EngineRelationships::*;

    // ---- Brief ----
    part selfsyncBrief : Brief {
        :>> id = "e4cc9b4a-edf0-42c9-8ea3-fd6d08433da6";
        :>> title = "SelfSync — self-hosted Obsidian sync";
        :>> createdAt = "2026-07-02";
        :>> createdBy = "wweatherholtz";
        :>> problem = "obsidian-livesync is powerful but notoriously hard to adopt: its configuration UI is confusing (dozens of cryptically-named toggles, easy to misconfigure), it depends on CouchDB (painful to self-host and operate), and its strongest conflict/diff-merge quality is gated behind sponsorship. Users self-hosting their notes get stuck at setup, fight the backend, or lose the merge quality they need.";
        :>> opportunity = "A fresh, self-hosted Obsidian sync — a single-binary Rust server (no CouchDB) plus a lean plugin — can deliver official-Sync-class ease with a guided setup, efficient content-addressed storage, and un-paywalled three-way conflict merge, all on infrastructure the user owns.";
        :>> constraintsNote = "Obsidian plugin (TypeScript, esbuild) + a self-hostable server; must run on desktop AND mobile (isDesktopOnly:false); distributed via BRAT; trusted-server + TLS-in-transit security model (content E2EE is a deferred option).";
    }

    // ---- Personas ----
    part selfHoster : Persona {
        :>> id = "04fae38b-fd54-42a1-ab46-19eda13d3122";
        :>> title = "Self-hosting Obsidian user";
        :>> createdAt = "2026-07-02";
        :>> createdBy = "wweatherholtz";
        :>> description = "A privacy-minded Obsidian user who wants their notes synced across devices on infrastructure they own, without a subscription and without operating a database. Comfortable running a container, not eager to babysit CouchDB.";
        :>> goals = "Sync notes across my devices on my own server; set it up once, quickly, without decoding cryptic settings; own my data end to end.";
    }
    part mobileUser : Persona {
        :>> id = "0290ffeb-e394-4c63-9f51-37ca76e58030";
        :>> title = "Mobile Obsidian user";
        :>> createdAt = "2026-07-02";
        :>> createdBy = "wweatherholtz";
        :>> description = "Uses Obsidian on a phone/tablet as well as desktop. Needs sync that works within mobile constraints (foreground, limited memory) and a UI that reads clearly on a small screen.";
        :>> goals = "Sync reliably between phone and desktop; see sync state at a glance on mobile.";
    }
    part migratingUser : Persona {
        :>> id = "0001823c-fc83-4c4f-93c3-d521c265041e";
        :>> title = "Migrating LiveSync user";
        :>> createdAt = "2026-07-02";
        :>> createdBy = "wweatherholtz";
        :>> description = "Currently on obsidian-livesync and frustrated by its setup friction, CouchDB operations, or paywalled merge. Wants a simpler alternative without losing conflict-safety.";
        :>> goals = "Escape CouchDB and confusing settings; keep strong, free conflict resolution.";
    }

    // =====================================================================
    // GOAL 1 — a clear, guided configuration experience (the #1 pain of LiveSync)
    // =====================================================================
    requirement goal1ClearConfig : Need {
        :>> id = "547cee47-9833-4080-b9ae-915ca476a3d9";
        :>> title = "Configuration is clear and guided, not confusing";
        :>> source = NeedSource::customer;
        :>> statement = "A user can set up and understand sync without decoding cryptic settings — setup is guided and each setting has one obvious home.";
        :>> marketJustification = "LiveSync's confusing config is its most-cited adoption barrier.";
        :>> priority = Priority::must;
    }
    requirement n1GuidedSetup : Need {
        :>> id = "31ee9f0a-c05a-4af5-8c5c-48864181080f";
        :>> title = "Guided first-run setup";
        :>> source = NeedSource::customer;
        :>> statement = "A new user is walked through connecting to their server and choosing a vault, without hand-editing opaque fields.";
        :>> priority = Priority::must;
    }
    requirement n1OneHomePerSetting : Need {
        :>> id = "e87d90b5-fddc-4dea-8dc7-5c08ea6656db";
        :>> title = "One clear home per setting";
        :>> source = NeedSource::customer;
        :>> statement = "Every setting lives in one obvious place, grouped by concern, with no duplicated or contradictory controls.";
        :>> priority = Priority::should;
    }
    requirement n1SingleIndicator : Need {
        :>> id = "2c042178-faed-474b-baf9-40ed7061bc92";
        :>> title = "One clear sync-state indicator";
        :>> source = NeedSource::customer;
        :>> statement = "The user sees a single, unambiguous indication of sync state, not several redundant indicators.";
        :>> priority = Priority::should;
    }

    // =====================================================================
    // GOAL 2 — a simple, fast, self-hosted backend with NO CouchDB
    // =====================================================================
    requirement goal2SimpleBackend : Need {
        :>> id = "bf9ec044-fd46-488d-b774-7ab9b43ea0b8";
        :>> title = "Simple, fast self-hosted backend without CouchDB";
        :>> source = NeedSource::customer;
        :>> statement = "A user can self-host sync with a single easy-to-run server and get fast sync, without operating CouchDB or any external database.";
        :>> marketJustification = "The CouchDB dependency is LiveSync's biggest operational pain.";
        :>> priority = Priority::must;
    }
    requirement n2NoCouchDB : Need {
        :>> id = "1af61c65-1abe-4946-a9dc-2fce163710a0";
        :>> title = "Single self-contained server (no external DB)";
        :>> source = NeedSource::operator;
        :>> statement = "The server runs as one self-contained binary/container with its own storage — no CouchDB, no separate database to provision or maintain.";
        :>> priority = Priority::must;
    }
    requirement n2Dedup : Need {
        :>> id = "a0bbfe25-989d-480d-a546-f3a178399107";
        :>> title = "Efficient storage via deduplication";
        :>> source = NeedSource::customer;
        :>> statement = "Storage and transfer are efficient — unchanged and duplicated content is not re-stored or re-sent.";
        :>> priority = Priority::should;
    }
    requirement n2Performance : Need {
        :>> id = "3d958048-37c9-4d31-9b9f-7b3eeec58692";
        :>> title = "Fast sync for large vaults and large files";
        :>> source = NeedSource::customer;
        :>> statement = "Sync stays responsive for large vaults and large/binary files without blocking other operations.";
        :>> priority = Priority::should;
    }

    // =====================================================================
    // GOAL 3 — strong, un-paywalled conflict detection + diff/merge
    // =====================================================================
    requirement goal3ConflictMerge : Need {
        :>> id = "2fec350f-432d-4ffc-9ad9-0b0cd9d90df4";
        :>> title = "Strong conflict resolution, free for everyone";
        :>> source = NeedSource::customer;
        :>> statement = "Concurrent edits are resolved well and no user ever silently loses data — and this quality is not gated behind payment.";
        :>> marketJustification = "LiveSync gates its best merge behind sponsorship; free strong merge is a differentiator.";
        :>> priority = Priority::must;
    }
    requirement n3ThreeWayMerge : Need {
        :>> id = "63e79d46-17fa-463c-910f-303c514759c5";
        :>> title = "Automatic three-way merge of concurrent edits";
        :>> source = NeedSource::customer;
        :>> statement = "When the same note is edited on two devices, non-conflicting changes are merged automatically.";
        :>> priority = Priority::must;
    }
    requirement n3NeverClobber : Need {
        :>> id = "04fa65ee-2355-45c3-ac8b-9dfb8a164d0f";
        :>> title = "Never silently lose data on conflict";
        :>> source = NeedSource::customer;
        :>> statement = "When changes cannot be merged cleanly, both versions are preserved (conflict copy) rather than one overwriting the other.";
        :>> priority = Priority::must;
    }
    requirement n3Unpaywalled : Need {
        :>> id = "241271c3-445c-45b0-b363-2830872acc90";
        :>> title = "Conflict/merge quality is not paywalled";
        :>> source = NeedSource::competitive;
        :>> statement = "The full conflict-detection and diff/merge experience is available to every user at no cost.";
        :>> priority = Priority::should;
    }

    // =====================================================================
    // Cross-cutting Needs
    // =====================================================================
    requirement nxMobile : Need {
        :>> id = "f7efcf39-e851-44d9-86cc-7332ab6317f6";
        :>> title = "Works on desktop and mobile";
        :>> source = NeedSource::customer;
        :>> statement = "Sync and its UI work on both desktop and mobile Obsidian.";
        :>> priority = Priority::must;
    }
    requirement nxSecurity : Need {
        :>> id = "31b84035-868e-47bd-8f89-ce661318f62d";
        :>> title = "User data and credentials are protected";
        :>> source = NeedSource::safety;
        :>> statement = "Notes are transferred securely to the user's own server, and SelfSync's own credentials (server, login, token) are never themselves synced into the vault.";
        :>> priority = Priority::must;
    }

    // ---- Post-launch capability: multi-user vault sharing (2026-07-04) ----
    requirement nVaultSharing : Need {
        :>> id = "393acf9e-8282-4b0b-8d70-80d6c5e1f936";
        :>> title = "Share a vault with other users on the server";
        :>> source = NeedSource::customer;
        :>> statement = "A vault owner can grant other accounts on the same server read-only or read-write access to a vault, and administer accounts + shares through a management interface.";
        :>> priority = Priority::should;
    }

    // ---- lineage: top goals derive from the Brief; sub-needs from their goal ----
    #DependsOn dependency from nVaultSharing to selfsyncBrief;
    #DependsOn dependency from goal1ClearConfig to selfsyncBrief;
    #DependsOn dependency from goal2SimpleBackend to selfsyncBrief;
    #DependsOn dependency from goal3ConflictMerge to selfsyncBrief;
    #DependsOn dependency from n1GuidedSetup to goal1ClearConfig;
    #DependsOn dependency from n1OneHomePerSetting to goal1ClearConfig;
    #DependsOn dependency from n1SingleIndicator to goal1ClearConfig;
    #DependsOn dependency from n2NoCouchDB to goal2SimpleBackend;
    #DependsOn dependency from n2Dedup to goal2SimpleBackend;
    #DependsOn dependency from n2Performance to goal2SimpleBackend;
    #DependsOn dependency from n3ThreeWayMerge to goal3ConflictMerge;
    #DependsOn dependency from n3NeverClobber to goal3ConflictMerge;
    #DependsOn dependency from n3Unpaywalled to goal3ConflictMerge;
}
