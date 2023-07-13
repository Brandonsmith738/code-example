import lz4 from 'lz4js';
import { RadarFrame } from '~/generated/radarframe';
import { colormapsMap, productCutoffs } from './colormaps';

export type Product = {
    product: string;
    radialCount: number;
    gateCount: number;
    colorMap: Map<number, number[]>;
    upperCutoff: number;
    lowerCutoff: number;
};

export type WorkerResult = {
    date: Date;
    longitude: number;
    latitude: number;
    vertices: ArrayBuffer;
    colors: ArrayBuffer;
};

export type WorkerOutput = {
    result?: WorkerResult;
    percentageComplete?: number;
};


const ctx: Worker = self as unknown as Worker;

ctx.addEventListener('message', (evt: MessageEvent<ArrayBuffer>) => {
    const frameUInt8 = Buffer.from(evt.data);

    const frameSize = frameUInt8.readInt32LE(0);

    const decompressedFrame: Uint8Array = lz4.decompress(frameUInt8.subarray(4), frameSize);

    const radarFrame = RadarFrame.decode(decompressedFrame);
    const product: Product = {
        product: radarFrame.ProductName || '',
        radialCount: radarFrame.RadialCount || 720,
        gateCount: radarFrame.GateCount || 0,
        colorMap: colormapsMap.get(radarFrame.ProductName ?? 'Reflectivity') ?? new Map<number, number[]>(),
        lowerCutoff: productCutoffs.get(radarFrame.ProductName ?? 'Reflectivity')?.lowerCutoff ?? 0,
        upperCutoff: productCutoffs.get(radarFrame.ProductName ?? 'Reflectivity')?.upperCutoff ?? 150,
    };

    const { colors, vertices } = calculateVerticesAndColors(radarFrame.StartAzimuthAngle, radarFrame.Gates, product);

    const message: WorkerOutput = {
        result: {
            date: radarFrame.Date,
            longitude: radarFrame.Longitude,
            latitude: radarFrame.Latitude,
            vertices: vertices.buffer,
            colors: colors.buffer,
        }
    };

    postMessage(message, [message.result!.colors, message.result!.vertices]);
});

const calculateVerticesAndColors = (azimuthStartData: number, ndArrayDataScan: number[], product: Product) => {
    const radius = productCutoffs.get(product.product)?.coneOfSilenceRadius ?? 21.25;
    const scaledResolution = productCutoffs.get(product.product)?.scaledResolution ?? 2.5;

    const verticesArray: number[] = [];

    const colorsArray: number[] = [];

    const newAzimuthStartData = ((360 - azimuthStartData + 90) / 360) * (2 * Math.PI);
    const degreeToRadianConversionRate = product.radialCount * 0.5;

    // Used to determine loading progress.
    let completedIterations = 0;

    for (let i = 0; i < product.radialCount; i++) {
        for (let j = 0; j < product.gateCount; j++) {
            const index = i * product.gateCount + j;

            if (ndArrayDataScan[index]! > product.lowerCutoff && ndArrayDataScan[index]! < product.upperCutoff) {
                verticesArray.push(
                    (radius + scaledResolution * (j + 1)) * Math.cos((Math.PI * (i + 1)) / degreeToRadianConversionRate + newAzimuthStartData),
                    (radius + scaledResolution * (j + 1)) * Math.sin((Math.PI * (i + 1)) / degreeToRadianConversionRate + newAzimuthStartData),
                    (radius + scaledResolution * j) * Math.cos((Math.PI * (i + 1)) / degreeToRadianConversionRate + newAzimuthStartData),
                    (radius + scaledResolution * j) * Math.sin((Math.PI * (i + 1)) / degreeToRadianConversionRate + newAzimuthStartData),
                    (radius + scaledResolution * (j + 1)) * Math.cos((Math.PI * i) / degreeToRadianConversionRate + newAzimuthStartData),
                    (radius + scaledResolution * (j + 1)) * Math.sin((Math.PI * i) / degreeToRadianConversionRate + newAzimuthStartData),

                    (radius + scaledResolution * j) * Math.cos((Math.PI * (i + 1)) / degreeToRadianConversionRate + newAzimuthStartData),
                    (radius + scaledResolution * j) * Math.sin((Math.PI * (i + 1)) / degreeToRadianConversionRate + newAzimuthStartData),
                    (radius + scaledResolution * j) * Math.cos((Math.PI * i) / degreeToRadianConversionRate + newAzimuthStartData),
                    (radius + scaledResolution * j) * Math.sin((Math.PI * i) / degreeToRadianConversionRate + newAzimuthStartData),
                    (radius + scaledResolution * (j + 1)) * Math.cos((Math.PI * i) / degreeToRadianConversionRate + newAzimuthStartData),
                    (radius + scaledResolution * (j + 1)) * Math.sin((Math.PI * i) / degreeToRadianConversionRate + newAzimuthStartData)
                );
                colorsArray.push(
                    ...interpolateColor(ndArrayDataScan[index]!, product.colorMap),
                    ...interpolateColor(ndArrayDataScan[index]!, product.colorMap),
                    ...interpolateColor(ndArrayDataScan[index]!, product.colorMap),
                    ...interpolateColor(ndArrayDataScan[index]!, product.colorMap),
                    ...interpolateColor(ndArrayDataScan[index]!, product.colorMap),
                    ...interpolateColor(ndArrayDataScan[index]!, product.colorMap)
                );
            }
        }
        completedIterations++;
        const percentageComplete = parseInt(((completedIterations / product.radialCount) * 100).toFixed(0));

        postMessage({ percentageComplete });
    }

    const vertices = new Float32Array(verticesArray);
    const colors = new Float32Array(colorsArray);

    return { vertices, colors };
};

const interpolateColor = (value: number, colormap: Map<number, number[]>): number[] => {
    const color = colormap.get(value);

    if (color) return color.map((c) => c / 255);

    // RGB expressed in each array as [R, G, B]
    let color1: number[] = [];
    let color2: number[] = [];

    let keyForColor1 = 0;
    let keyForColor2 = 0;

    for (const [key, color] of colormap.entries()) {

        if (key <= value) {
            color1 = color;
            keyForColor1 = key;
            if (colormap.entries().next().value[0] >= 0) break;
        }
        if (key >= value) {
            color2 = color;
            keyForColor2 = key;
            if (colormap.entries().next().value[0] <= 0) break;

        }
    }


    const ratio = (value - keyForColor1) / (keyForColor2 - keyForColor1);

    const r = Math.round(color1[0]! + (color2[0]! - color1[1]!) * ratio) / 255;

    const g = Math.round(color1[1]! + (color2[1]! - color1[1]!) * ratio) / 255;

    const b = Math.round(color1[2]! + (color2[2]! - color1[2]!) * ratio) / 255;

    return [parseFloat(r.toFixed(2)), parseFloat(g.toFixed(2)), parseFloat(b.toFixed(2))];
};
