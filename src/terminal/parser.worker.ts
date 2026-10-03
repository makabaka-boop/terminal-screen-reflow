/// <reference lib="webworker" />
import { AnsiParser, initialParserState } from './parser';
import type { EventsBlock, ParseRequest, WorkerRequest, WorkerResponse } from './types';

declare const self: DedicatedWorkerGlobalScope;

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  if ('type' in request && request.type === 'shutdown') {
    self.close();
    return;
  }

  const parse = request as ParseRequest;

  try {
    const parser = new AnsiParser(parse.state ?? initialParserState());
    const wanted = new Set<number>();
    const end = parse.start + parse.bytes.length;
    for (let offset = parse.start; offset <= end; offset++) {
      if (offset % parse.checkpointEvery === 0) wanted.add(offset);
    }

    const result = parser.feed(parse.bytes, parse.start, wanted);
    const response: EventsBlock = {
      type: 'events',
      generation: parse.generation,
      start: parse.start,
      end: parse.start + parse.bytes.length,
      events: result.events,
      checkpoints: result.checkpoints.map(checkpoint => ({
        offset: checkpoint.offset,
        parser: checkpoint.state,
        eventCount: checkpoint.eventCount
      }))
    };
    self.postMessage(response);
  } catch (error) {
    const response: WorkerResponse = {
      type: 'error',
      generation: parse.generation,
      message: error instanceof Error ? error.message : String(error)
    };
    self.postMessage(response);
  }
};
