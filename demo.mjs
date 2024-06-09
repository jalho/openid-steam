import * as http from "node:http";
import * as undici from "undici";
import * as assert from "node:assert";

async function main() {
    const config = {
        listen_host: "0.0.0.0",
        listen_port: 8080,

        steam_openid: {
            url: new URL("https://steamcommunity.com/openid/login"),
            /**
             * "9.1.  Request Parameters"
             * https://openid.net/specs/openid-authentication-2_0.html
             * [Accessed 2024-06-09]
             */
            params: {
                "openid.mode":       "checkid_setup",
                "openid.mode":       "checkid_setup",
                "openid.ns":         "http://specs.openid.net/auth/2.0",
                "openid.identity":   "http://specs.openid.net/auth/2.0/identifier_select",
                "openid.claimed_id": "http://specs.openid.net/auth/2.0/identifier_select",
                "openid.return_to":  "http://localhost:8080/auth/steam", // TODO: Bind to listen addr & routing
                "openid.realm":      "http://localhost:8080",            // TODO: Bind to listen addr
            },
        },
    };
    const server = http.createServer((i, o) => handle(config, i, o));
    server.listen(
        { host: config.listen_host, port: config.listen_port },
        () => console.log("Listening on", server.address()),
    );
}

async function handle(config, i, o) {
    console.log("[%s] %s %s", new Date().toISOString(), i.method, i.url);

    switch (true) {
        /*
            TODO: Add a site that has a button that conforms with graphics
            defined in https://partner.steamgames.com/doc/features/auth#website
            [Accessed 2024-06-09]
        */
        case i.url === "/": {
            const url_redir_mut = new URL(config.steam_openid.url);
            url_redir_mut.search = "";
            for (const [k, v] of Object.entries(config.steam_openid.params)) {
                url_redir_mut.searchParams.append(k, v);
            }
            o.setHeader("Location", url_redir_mut.toString());
            o.statusCode = 303;
            o.end();
            return;
        }
        case i.url.startsWith("/auth/steam"): {
            const { searchParams: params_in } = new URL(i.url, "http://localhost");
            const claimed_steam_id = parse_oid_claimed_id_steam(params_in.get("openid.claimed_id"));
            const params_out = {
                "openid.mode": "check_authentication",
            };
            for (const [k, v] of params_in) {
                if (k === "openid.mode") continue;
                params_out[k] = v;
            }
            const url_auth_check_mut = new URL(config.steam_openid.url);
            url_auth_check_mut.search = "";
            for (const [k, v] of Object.entries(params_out)) {
                url_auth_check_mut.searchParams.append(k, v);
            }

            const response = await undici.request(
                url_auth_check_mut,
                { method: "POST" },
            );
            if (response.statusCode !== 200) {
                o.statusCode = 500;
                o.end();
                return;
            }

            const buf = Buffer.from(await response.body.arrayBuffer());
            let is_valid = false;
            try {
                const { is_valid: n } = parse_oid_check_authentication(buf.toString());
                is_valid = n;
            } catch (err_parse) {
                console.error("Failed to parse Steam OID check_authentication response -- status %d, hex: '%s':",
                    response.statusCode, buf.toString("hex"), err_parse);
                o.statusCode = 500;
                o.end();
                return;
            }
            o.statusCode = is_valid ? 200 : 401;
            console.log("[%s] Steam ID '%s' authenticated: %s",
                new Date().toISOString(), claimed_steam_id, is_valid);
            o.end();
            return;
        }
        case i.url === "/favicon.ico": {
            o.statusCode = 204;
            o.end();
            return;
        }
        default: {
            o.statusCode = 404;
            o.end();
            return;
        }
    }
}

/**
 * Parse OpenID auth check response payload (openid.mode: check_authentication).
 *
 * @param {string} response E.g. `ns:http://specs.openid.net/auth/2.0\nis_valid:false\n`
 * @returns {{ ns: string; is_valid: boolean }} Response payload of an OID auth check
 */
function parse_oid_check_authentication(response) {
    const result = {};
    const entries = response.split("\n").filter(n => !!n);
    for (const entry of entries) {
        if (entry.startsWith("ns:")) {
            result.ns = entry.substring("ns:".length, entry.length);
        }
        else if (entry.startsWith("is_valid:")) {
            result.is_valid = entry.substring("is_valid:".length, entry.length);
            if      (result.is_valid === "true") result.is_valid = true;
            else if (result.is_valid === "false") result.is_valid = false;
            else throw new Error("Could not parse value 'is_valid' as boolean");
        }
        else throw new Error(`Unknown entry '${entry}'`);
    }
    if ("ns" in result && "is_valid" in result) return result;
    else throw new Error("Expected entries 'ns' and 'is_valid'");
}
assert.deepStrictEqual(
    parse_oid_check_authentication("ns:http://specs.openid.net/auth/2.0\nis_valid:false\n"),
    {
        ns: "http://specs.openid.net/auth/2.0",
        is_valid: false,
    },
    "parse 'ns' and 'is_valid' from OpenID auth check response payload"
);

/**
 * Parse Steam ID from an OpenID `openid.claimed_id` payload.
 *
 * @param {string} claimed_id E.g. `https://steamcommunity.com/openid/id/00000000000000000`
 * @returns {string} Steam ID
 */
function parse_oid_claimed_id_steam(claimed_id) {
    const idx = claimed_id.lastIndexOf("/");
    assert.equal(idx > 0, true, "idx is gt 0");
    const steam_id = claimed_id.substring(idx + 1, claimed_id.length);
    if (steam_id.length !== 17) throw new Error("Could not parse Steam ID from 'claimed_id'");
    return steam_id;
}
assert.equal(
    parse_oid_claimed_id_steam("https://steamcommunity.com/openid/id/00000000000000000"),
    "00000000000000000",
    "parse Steam ID from openid.claimed_id"
)

main();
