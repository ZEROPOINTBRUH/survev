import { Config } from "./config";
import { version } from "../package.json";

import {
    App,
    DEDICATED_COMPRESSOR_256KB,
    type HttpResponse,
    SSLApp,
    type WebSocket
} from "uWebSockets.js";

import { URLSearchParams } from "node:url";
import { Game } from "./game";
import { Logger } from "./utils/logger";
import { type Player } from "./objects/player";

/**
 * Apply CORS headers to a response.
 * @param res The response sent by the server.
 */
function cors(res: HttpResponse): void {
    res.writeHeader("Access-Control-Allow-Origin", "*")
        .writeHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        .writeHeader("Access-Control-Allow-Headers", "origin, content-type, accept, x-requested-with")
        .writeHeader("Access-Control-Max-Age", "3600");
}

function forbidden(res: HttpResponse): void {
    res.writeStatus("403 Forbidden").end("403 Forbidden");
}

/**
 * Read the body of a POST request.
 * @link https://github.com/uNetworking/uWebSockets.js/blob/master/examples/JsonPost.js
 * @param res The response from the client.
 * @param cb A callback containing the request body.
 * @param err A callback invoked whenever the request cannot be retrieved.
 */
function readPostedJSON<T>(
    res: HttpResponse,
    cb: (json: T) => void,
    err: () => void
): void {
    let buffer: Buffer | Uint8Array;
    /* Register data cb */
    res.onData((ab, isLast) => {
        const chunk = Buffer.from(ab);
        if (isLast) {
            let json: T;
            if (buffer) {
                try {
                    // @ts-expect-error JSON.parse can accept a Buffer as an argument
                    json = JSON.parse(Buffer.concat([buffer, chunk]));
                } catch (e) {
                    /* res.close calls onAborted */
                    res.close();
                    return;
                }
                cb(json);
            } else {
                try {
                    // @ts-expect-error JSON.parse can accept a Buffer as an argument
                    json = JSON.parse(chunk);
                } catch (e) {
                    /* res.close calls onAborted */
                    res.close();
                    return;
                }
                cb(json);
            }
        } else {
            if (buffer) {
                buffer = Buffer.concat([buffer, chunk]);
            } else {
                buffer = Buffer.concat([chunk]);
            }
        }
    });

    /* Register error cb */
    res.onAborted(err);
}

// Initialize the server
const app = Config.ssl
    ? SSLApp({
        key_file_name: Config.ssl.keyFile,
        cert_file_name: Config.ssl.certFile
    })
    : App();

const games: Array<Game | undefined> = [];

const logger = new Logger("Server");

export function newGame(id?: number): number {
    if (id !== undefined) {
        if (!games[id] || games[id]?.stopped) {
            games[id] = new Game(id, Config);
            return id;
        }
    } else {
        for (let i = 0; i < Config.maxGames; i++) {
            if (!games[i] || games[i]?.stopped) return newGame(i);
        }
    }
    return -1;
}

export function endGame(id: number, createNewGame: boolean): void {
    const game = games[id];
    if (game === undefined) return;
    game.allowJoin = false;
    game.stopped = true;
    for (const player of game.connectedPlayers) {
        player.socket.close();
    }
    game.logger.log(`Game ${id} | Ended`);
    if (createNewGame) {
        games[id] = new Game(id, Config);
    } else {
        games[id] = undefined;
    }
}

function canJoin(game?: Game): boolean {
    return game !== undefined && game.aliveCount < Config.maxPlayersPerGame && !game.over;
}

app.get("/api/site_info", (res) => {
    let aborted = false;
    res.onAborted(() => { aborted = true; });
    cors(res);

    const playerCount = games.reduce((a, b) => {
        return a + (b ? b.connectedPlayers.size : 0);
    }, 0);

    const data = {
        modes: [
            { mapName: Config.map, teamMode: 1 }
        ],
        pops: {
            local: `${playerCount} players`
        },
        youtube: { name: "", link: "" },
        twitch: [],
        promptConsent: false,
        country: "US"
    };

    if (!aborted) {
        res.cork(() => {
            res.writeHeader("Content-Type", "application/json").end(JSON.stringify(data));
        });
    }
});

app.post("/api/user/profile", (res, req) => {
    res.writeHeader("Content-Type", "application/json");
    res.end("{err: \"\"}");
});
app.post("/api/user/get_pass", (res, req) => {
    res.writeHeader("Content-Type", "application/json");
    res.end("{err: \"\"}");
});

app.post("/api/find_game", async(res) => {
    readPostedJSON(res, (body: { region: string | number, zones: any[] }) => {
        let response: {
            zone: string
            gameId: number
            useHttps: boolean
            hosts: string[]
            addrs: string[]
            data: string
        } | { err: string } = {
            zone: "",
            data: "",
            gameId: 0,
            useHttps: true,
            hosts: [],
            addrs: []
        };

        const region = (Config.regions[body?.region] ?? Config.regions[Config.defaultRegion]);
        if (region !== undefined) {
            response.hosts.push(region.address);
            response.addrs.push(region.address);
            response.useHttps = region.https;

            let foundGame = false;
            for (let gameID = 0; gameID < Config.maxGames; gameID++) {
                const game = games[gameID];
                if (canJoin(game) && game?.allowJoin) {
                    response.gameId = game.id;
                    foundGame = true;
                    break;
                }
            }
            if (!foundGame) {
                // Create a game if there's a free slot
                const gameID = newGame();
                if (gameID !== -1) {
                    response.gameId = gameID;
                } else {
                    // Join the game that most recently started
                    const game = games
                        .filter(g => g && !g.over)
                        .reduce((a, b) => (a!).startedTime > (b!).startedTime ? a : b);

                    if (game) response.gameId = game.id;
                    else response = { err: "failed finding game" };
                }
            }
        } else {
            logger.warn("/api/find_game: Invalid region");
            response = {
                err: "Invalid Region"
            };
        }

        res.writeHeader("Content-Type", "application/json");
        res.end(JSON.stringify({
            res: [response]
        }));
    }, () => {
        logger.warn("/api/find_game: Error retrieving body");
    });
});

export interface PlayerContainer {
    readonly gameID: number
    player?: Player
}

app.ws("/play", {
    compression: DEDICATED_COMPRESSOR_256KB,
    idleTimeout: 30,

    /**
     * Upgrade the connection to WebSocket.
     */
    upgrade(res, req, context) {
        /* eslint-disable-next-line @typescript-eslint/no-empty-function */
        res.onAborted((): void => { });

        const searchParams = new URLSearchParams(req.getQuery());

        //
        // Validate game ID
        //
        let gameID = Number(searchParams.get("gameID"));
        if (gameID < 0 || gameID > Config.maxGames - 1) gameID = 0;
        if (!canJoin(games[gameID])) {
            forbidden(res);
            return;
        }

        //
        // Upgrade the connection
        //
        const userData: PlayerContainer = {
            gameID,
            player: undefined
        };
        res.upgrade(
            userData,
            req.getHeader("sec-websocket-key"),
            req.getHeader("sec-websocket-protocol"),
            req.getHeader("sec-websocket-extensions"),
            context
        );
    },

    /**
     * Handle opening of the socket.
     * @param socket The socket being opened.
     */
    open(socket: WebSocket<PlayerContainer>) {
        const data = socket.getUserData();
        const game = games[data.gameID];
        if (game === undefined) return;
        data.player = game.addPlayer(socket);
    },

    /**
     * Handle messages coming from the socket.
     * @param socket The socket in question.
     * @param message The message to handle.
     */
    message(socket: WebSocket<PlayerContainer>, message) {
        try {
            const player = socket.getUserData().player;
            if (player === undefined) return;
            player.game.handleMsg(message, player);
        } catch (e) {
            console.warn("Error parsing message:", e);
        }
    },

    /**
     * Handle closing of the socket.
     * @param socket The socket being closed.
     */
    close(socket: WebSocket<PlayerContainer>) {
        const data = socket.getUserData();
        const game = games[data.gameID];
        const player = data.player;
        if (game === undefined || player === undefined) return;
        game.logger.log(`"${player.name}" left`);
        game.removePlayer(player);
    }
});

// Start the server
app.listen(Config.host, Config.port, (): void => {
    logger.log(`Resurviv Server v${version}`);
    logger.log(`Listening on ${Config.host}:${Config.port}`);
    logger.log("Press Ctrl+C to exit.");

    newGame(0);
});

setInterval(() => {
    const memoryUsage = process.memoryUsage().rss;

    const perfString = `Server | Memory usage: ${Math.round(memoryUsage / 1024 / 1024 * 100) / 100} MB`;

    logger.log(perfString);
}, 60000);
