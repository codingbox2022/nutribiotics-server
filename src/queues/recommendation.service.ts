import { Injectable, Logger } from '@nestjs/common';
import { generateText } from 'ai';
import { z } from 'zod';
import { perplexity } from '@ai-sdk/perplexity';

export interface CompetitorPriceData {
  marketplaceName: string;
  productName: string;
  brandName: string;
  precioConIva: number;
  precioSinIva: number;
  pricePerIngredientContent: Record<string, number>;
  ingredientContent: Record<string, number>;
}

export interface RecommendationInput {
  productName: string;
  currentPrice: number | null;
  ingredientContent: Record<string, number>;
  competitorPrices: CompetitorPriceData[];
  minCompetitorPrice: number;
  maxCompetitorPrice: number;
  avgCompetitorPrice: number;
}

export interface RecommendationOutput {
  recommendation: 'raise' | 'lower' | 'keep';
  reasoning: string;
  suggestedPrice?: number;
}

const recommendationSchema = z.object({
  recommendation: z.enum(['raise', 'lower', 'keep']),
  reasoning: z.string(),
  suggestedPrice: z.number().optional(),
});

@Injectable()
export class RecommendationService {
  private readonly logger = new Logger(RecommendationService.name);

  async generateRecommendation(
    input: RecommendationInput,
  ): Promise<RecommendationOutput> {
    const {
      productName,
      currentPrice,
      ingredientContent,
      competitorPrices,
      minCompetitorPrice,
      maxCompetitorPrice,
      avgCompetitorPrice,
    } = input;

    try {
      // Build ingredient comparison breakdown
      const ingredientBreakdown = this.buildIngredientBreakdown(
        ingredientContent,
        competitorPrices,
      );

      // Build competitor summary
      const competitorSummary = competitorPrices
        .map(
          (c) =>
            `  - ${c.productName} (${c.brandName}) on ${c.marketplaceName}: $${c.precioConIva.toFixed(2)} (sin IVA: $${c.precioSinIva.toFixed(2)})`,
        )
        .join('\n');

      const prompt = `Eres un experto en estrategia de precios para una compañía de suplementos nutricionales llamada Nutribiotics. Analiza los siguientes datos de precios del producto y proporciona una recomendación.

**Producto:** ${productName}
**Precio Actual:** ${currentPrice !== null ? `$${currentPrice.toFixed(2)} COP` : 'No definido'}
**Contenido de Ingredientes:** ${JSON.stringify(ingredientContent, null, 2)}

**Análisis del Mercado Competidor:**
- Precio Mínimo: $${minCompetitorPrice.toFixed(2)} COP
- Precio Máximo: $${maxCompetitorPrice.toFixed(2)} COP
- Precio Promedio: $${avgCompetitorPrice.toFixed(2)} COP
- Número de competidores rastreados: ${competitorPrices.length}

**Productos Competidores:**
${competitorSummary}

**Análisis de Precio por Ingrediente:**
${ingredientBreakdown}

**Tarea:**
Basándote en estos datos, recomienda si Nutribiotics debe:
1. **raise** - Aumentar el precio (si estamos significativamente por debajo del precio comparado con el valor)
2. **lower** - Disminuir el precio (si estamos sobrevalorados comparado con los competidores)
3. **keep** - Mantener el precio actual (si estamos competitivamente posicionados)

Considera:
- Valor del contenido de ingredientes (mayor contenido = mayor valor)
- Posicionamiento competitivo relativo a precios mín/máx/promedio
- Eficiencia del precio por ingrediente
- Brechas y oportunidades del mercado

Retorna SOLO un objeto JSON válido (sin markdown, sin texto extra) con:
- recommendation: "raise" | "lower" | "keep"
- reasoning: Una explicación clara de 2-3 oraciones EN ESPAÑOL
- suggestedPrice: (opcional) Precio recomendado en COP si aumenta o disminuye

Ejemplo:
{
  "recommendation": "lower",
  "reasoning": "El precio actual de $50,000 está 15% por encima del promedio del mercado de $43,500. Aunque el contenido de ingredientes es comparable a los competidores, el precio no es lo suficientemente competitivo para impulsar las ventas.",
  "suggestedPrice": 44000
}`;

      const result = await generateText({
        model: perplexity('sonar-pro'),
        prompt,
      });

      // Parse JSON response
      let parsed: z.infer<typeof recommendationSchema>;
      try {
        let jsonText = result.text.trim();

        // Remove markdown code blocks if present
        if (jsonText.startsWith('```')) {
          jsonText = jsonText
            .replace(/```json?\n?/g, '')
            .replace(/```\n?$/g, '');
        }

        // Extract only the JSON object
        const firstBrace = jsonText.indexOf('{');
        const lastBrace = jsonText.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace !== -1) {
          jsonText = jsonText.substring(firstBrace, lastBrace + 1);
        }

        const jsonResponse = JSON.parse(jsonText);
        parsed = recommendationSchema.parse(jsonResponse);
      } catch (parseError) {
        this.logger.error(
          `Failed to parse recommendation for ${productName}: ${parseError.message}`,
        );
        this.logger.debug(`Raw response: ${result.text}`);

        // Return fallback recommendation
        return {
          recommendation: 'keep',
          reasoning: 'Unable to generate AI recommendation. Manual review recommended.',
        };
      }

      this.logger.log(
        `Generated recommendation for ${productName}: ${parsed.recommendation}`,
      );

      return parsed;
    } catch (error) {
      this.logger.error(
        `Error generating recommendation for ${productName}: ${error.message}`,
      );

      // Return safe fallback
      return {
        recommendation: 'keep',
        reasoning: 'Error during recommendation generation. Manual review needed.',
      };
    }
  }

  private buildIngredientBreakdown(
    productIngredients: Record<string, number>,
    competitorPrices: CompetitorPriceData[],
  ): string {
    const lines: string[] = [];

    for (const [ingredientName, content] of Object.entries(productIngredients)) {
      const competitorValues = competitorPrices
        .map((c) => {
          const compContent = c.ingredientContent[ingredientName];
          const compPricePerUnit = c.pricePerIngredientContent[ingredientName];
          if (compContent && compPricePerUnit) {
            return {
              name: c.productName,
              content: compContent,
              pricePerUnit: compPricePerUnit,
            };
          }
          return null;
        })
        .filter(Boolean);

      if (competitorValues.length > 0) {
        const avgCompPricePerUnit =
          competitorValues.reduce((sum, v) => sum + v!.pricePerUnit, 0) /
          competitorValues.length;
        lines.push(
          `  ${ingredientName}: ${content} units | Avg competitor price/unit: $${avgCompPricePerUnit.toFixed(2)}`,
        );
      } else {
        lines.push(`  ${ingredientName}: ${content} units | No competitor data`);
      }
    }

    return lines.length > 0 ? lines.join('\n') : 'No ingredient data available';
  }
}
