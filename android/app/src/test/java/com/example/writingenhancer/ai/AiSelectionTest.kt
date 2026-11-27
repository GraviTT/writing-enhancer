package com.example.writingenhancer.ai

import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import org.json.JSONObject

class AiSelectionTest {
    @Test fun geminiStructuredAnswerSkipsThoughtsAndCombinesAnswerParts() {
        val response = JSONObject("""{"candidates":[{"content":{"parts":[{"text":"private","thought":true},{"text":"one"},{"thoughtSignature":"s"},{"text":"two"}]}}]}""")
        assertEquals("onetwo", geminiAnswerText(response))
    }

    @Test fun everyOptionUsesOnlyItsProviderKeyAndExactModel() {
        for (provider in AiProvider.values()) for ((id, _) in provider.models) {
            val keyReads = mutableListOf<String>()
            val result = AiSelection(provider, id).call({
                keyReads += it
                "test-key"
            }, { _, model -> "openai:$model" }, { _, model -> "gemini:$model" })
            assertEquals(listOf(provider.keyName), keyReads)
            assertEquals("${provider.id}:$id", result)
        }
    }

    @Test fun failureAndMissingKeyNeverCallTheOtherProvider() {
        for (provider in AiProvider.values()) {
            val selection = AiSelection(provider, provider.models.last().first)
            val attempts = mutableListOf<String>()
            val failure = IOException("unavailable")
            val run: (String?) -> Throwable? = { key ->
                runCatching {
                    selection.call({ if (it == provider.keyName) key else "other" },
                        { _, _ -> attempts += "openai"; throw failure },
                        { _, _ -> attempts += "gemini"; throw failure })
                }.exceptionOrNull()
            }
            assertTrue(run(null) is MissingApiKeyException)
            assertTrue(attempts.isEmpty())
            assertSame(failure, run("valid"))
            assertEquals(listOf(provider.id), attempts)
        }
    }

    @Test fun unsupportedStoredModelIsNotSilentlyReplaced() {
        val error = runCatching {
            AiSelection(AiProvider.GPT, "unavailable-model").call(
                { error("must not read a key") }, { _, _ -> error("unexpected") }, { _, _ -> error("unexpected") })
        }.exceptionOrNull()
        assertTrue(error is IllegalArgumentException)
    }
}
